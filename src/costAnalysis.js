// @flow
import assert from 'assert'
import selectn from 'selectn'
import { getArgumentValues } from 'graphql/execution/values'
import {
  GraphQLObjectType,
  GraphQLInterfaceType,
  Kind,
  getNamedType,
  GraphQLError
} from 'graphql'

import type {
  ValidationContext,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  FieldNode,
  InlineFragmentNode,
  DirectiveNode,
  GraphQLNamedType
} from 'graphql'

export type CostAnalysisOptions = {
  maximumCost: number,
  variables?: Object,
  onComplete?: (cost: number) => void,
  createError?: (maximumCost: number, cost: number) => GraphQLError,
  defaultCost?: number,
  costMap?: Object,
  complexityRange?: { min: number, max: number }
}

type NodeType =
  | FieldNode
  | OperationDefinitionNode
  | FragmentDefinitionNode
  | InlineFragmentNode

type NodeCostConfiguration = {
  multiplier?: ?number,
  useMultipliers?: boolean,
  complexity?: number
}

function costAnalysisMessage (max, actual) {
  return (
    `The query exceeds the maximum cost of ${max}. ` +
    `Actual cost is ${actual}`
  )
}

export default class CostAnalysis {
  context: ValidationContext
  cost: number
  options: CostAnalysisOptions
  fragments: { [name: string]: FragmentDefinitionNode }
  OperationDefinition: Object
  multipliers: Array<number>
  defaultCost: number

  constructor (context: ValidationContext, options: CostAnalysisOptions) {
    assert(
      typeof options.maximumCost === 'number' && options.maximumCost > 0,
      'Maximum query cost must be a positive number'
    )

    if (options.complexityRange) {
      assert(
        options.complexityRange.min &&
          options.complexityRange.max &&
          options.complexityRange.min < options.complexityRange.max,
        'Invalid minimum and maximum complexity'
      )
    }

    this.context = context
    this.cost = 0
    this.options = options
    this.multipliers = []
    this.defaultCost = this.options.defaultCost || 0

    this.OperationDefinition = {
      enter: this.onOperationDefinitionEnter,
      leave: this.onOperationDefinitionLeave
    }
  }

  onOperationDefinitionEnter (operation: OperationDefinitionNode) {
    switch (operation.operation) {
      case 'query':
        this.cost += this.computeNodeCost(
          operation,
          this.context.getSchema().getQueryType()
        )
        break
      case 'mutation':
        this.cost += this.computeNodeCost(
          operation,
          this.context.getSchema().getMutationType()
        )
        break
      case 'subscription':
        this.cost += this.computeNodeCost(
          operation,
          this.context.getSchema().getSubscriptionType()
        )
        break
      default:
        throw new Error(
          `Query Cost could not be calculated for operation of type ${
            operation.operation
          }`
        )
    }
  }

  onOperationDefinitionLeave (): ?GraphQLError {
    if (this.options.onComplete) {
      this.options.onComplete(this.cost)
    }

    if (this.cost > this.options.maximumCost) {
      return this.context.reportError(this.createError())
    }
  }

  computeCost ({
    multiplier,
    useMultipliers = true,
    complexity = (this.options.complexityRange &&
      this.options.complexityRange.min) ||
      1
  }: NodeCostConfiguration) {
    if (
      this.options.complexityRange &&
      (complexity > this.options.complexityRange.max ||
        complexity < this.options.complexityRange.min)
    ) {
      this.context.reportError(
        new GraphQLError(
          `The complexity argument must be between ` +
            `${this.options.complexityRange.min} and ${
              this.options.complexityRange.max
            }`
        )
      )
      return this.defaultCost
    }

    if (useMultipliers) {
      if (multiplier) {
        this.multipliers.push(parseInt(multiplier))
      }
      return this.multipliers.reduce(
        (acc, multiplier) => acc * multiplier,
        complexity
      )
    }
    return complexity
  }

  computeCostFromTypeMap (
    node: FieldNode,
    parentType: string,
    fieldArgs: { [argument: string]: mixed }
  ) {
    const costObject =
      this.options.costMap &&
      this.options.costMap[parentType] &&
      this.options.costMap[parentType][node.name.value]

    if (!costObject) {
      return this.defaultCost
    }

    let { useMultipliers, multiplier, complexity } = costObject
    multiplier = multiplier && selectn(multiplier, fieldArgs)

    return this.computeCost({ useMultipliers, multiplier, complexity })
  }

  computeCostFromDirectives (
    directives: $ReadOnlyArray<DirectiveNode>,
    fieldArgs: { [argument: string]: mixed }
  ) {
    const costDirective = directives.find(
      directive => directive.name.value === 'cost'
    )
    if (costDirective && costDirective.arguments) {
      // get cost arguments
      const complexityArg = costDirective.arguments.find(
        arg => arg.name.value === 'complexity'
      )
      const useMultipliersArg =
        costDirective.arguments &&
        costDirective.arguments.find(arg => arg.name.value === 'useMultipliers')
      const multiplierArg =
        costDirective.arguments &&
        costDirective.arguments.find(arg => arg.name.value === 'multiplier')

      // get arguments's values
      const useMultipliers =
        useMultipliersArg &&
        useMultipliersArg.value &&
        useMultipliersArg.value.kind === 'BooleanValue'
          ? useMultipliersArg.value.value
          : true

      const multiplier: ?number =
        multiplierArg && multiplierArg.value.value
          ? parseInt(selectn(multiplierArg.value.value, fieldArgs))
          : undefined

      const complexity =
        complexityArg &&
        complexityArg.value &&
        complexityArg.value.kind === 'IntValue'
          ? parseInt(complexityArg.value.value)
          : 1

      return this.computeCost({ multiplier, useMultipliers, complexity })
    }
    return this.defaultCost
  }

  computeNodeCost (node: NodeType, typeDef: ?GraphQLNamedType): number {
    if (!node.selectionSet) {
      return 0
    }
    let fields = {}
    if (
      typeDef instanceof GraphQLObjectType ||
      typeDef instanceof GraphQLInterfaceType
    ) {
      fields = typeDef.getFields()
    }
    return node.selectionSet.selections.reduce((total: number, childNode) => {
      let nodeCost: number = this.defaultCost

      // empty array of multipliers if field is at the root of an operation
      if (node.kind === Kind.OPERATION_DEFINITION) {
        this.multipliers = []
      }

      switch (childNode.kind) {
        case Kind.FIELD: {
          const field: Object = fields[childNode.name.value]
          // Invalid field, should be caught by other validation rules
          if (!field) {
            break
          }
          const fieldType = getNamedType(field.type)

          // get field's arguments
          let fieldArgs = {}
          try {
            fieldArgs = getArgumentValues(
              field,
              childNode,
              this.options.variables || {}
            )
          } catch (e) {
            this.context.reportError(e)
          }

          // it the costMap option is set, compute the cost with the costMap provided
          // by the user.
          if (
            this.options.costMap &&
            typeof this.options.costMap === 'object'
          ) {
            nodeCost =
              typeDef && typeDef.name
                ? this.computeCostFromTypeMap(
                  childNode,
                  typeDef.name,
                  fieldArgs
                )
                : this.defaultCost
          } else {
            // Compute cost of current field with its directive
            let costIsComputed: boolean = false
            if (field.astNode && field.astNode.directives) {
              nodeCost = this.computeCostFromDirectives(
                field.astNode.directives,
                fieldArgs
              )
              const costDirective = field.astNode.directives.find(
                directive => directive.name.value === 'cost'
              )
              if (costDirective && costDirective.arguments) {
                costIsComputed = true
              }
            }
            // if the cost directive is defined on the Type
            // and the nodeCost has not already been computed
            if (
              fieldType &&
              fieldType.astNode &&
              fieldType.astNode.directives &&
              fieldType instanceof GraphQLObjectType &&
              costIsComputed === false
            ) {
              nodeCost = this.computeCostFromDirectives(
                fieldType.astNode.directives,
                fieldArgs
              )
            }
          }

          let childCost = 0
          childCost = this.computeNodeCost(childNode, fieldType)
          nodeCost += childCost
          break
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragment = this.context.getFragment(childNode.name.value)
          const fragmentType =
            fragment &&
            this.context.getSchema().getType(fragment.typeCondition.name.value)
          nodeCost = fragment
            ? this.computeNodeCost(fragment, fragmentType)
            : this.defaultCost
          break
        }
        case Kind.INLINE_FRAGMENT: {
          let inlineFragmentType = typeDef
          if (childNode.typeCondition && childNode.typeCondition.name) {
            inlineFragmentType = this.context
              .getSchema()
              // $FlowFixMe: don't know why Flow thinks it could be undefined
              .getType(childNode.typeCondition.name.value)
          }
          nodeCost = childNode
            ? this.computeNodeCost(childNode, inlineFragmentType)
            : this.defaultCost
          break
        }
        default: {
          nodeCost = this.computeNodeCost(childNode, typeDef)
          break
        }
      }
      return Math.max(nodeCost, 0) + total
    }, 0)
  }

  createError (): GraphQLError {
    if (typeof this.options.createError === 'function') {
      return this.options.createError(this.options.maximumCost, this.cost)
    }
    return new GraphQLError(
      costAnalysisMessage(this.options.maximumCost, this.cost)
    )
  }
}
