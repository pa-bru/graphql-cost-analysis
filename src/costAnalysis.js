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
  GraphQLNamedType,
  ValueNode,
  ArgumentNode,
  SelectionNode
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
  complexity?: number,
  multipliers?: Array<number>
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
  operationMultipliers: Array<number>
  defaultCost: number
  defaultComplexity: number

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
    this.operationMultipliers = []
    this.defaultCost = this.options.defaultCost || 0
    this.defaultComplexity =
      (this.options.complexityRange && this.options.complexityRange.min) || 1

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
    complexity = this.defaultComplexity,
    multipliers = []
  }: NodeCostConfiguration = {}): number {
    if (typeof arguments[0] !== 'object') {
      return this.defaultCost
    }

    // multiplier is deprecated
    if (multiplier) {
      multipliers = multipliers.length ? multipliers : [multiplier]
      process.env.NODE_ENV !== 'production' &&
        console.warn(
          `The multiplier property is DEPRECATED and will be removed in the next release. \n` +
            `Please use the multipliers field instead.`
        )
    }

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
      if (multipliers.length) {
        const multiplier = multipliers.reduce(
          (total, current) => total + current,
          0
        )
        this.operationMultipliers = [...this.operationMultipliers, multiplier]
      }
      return this.operationMultipliers.reduce(
        (acc, multiplier) => acc * multiplier,
        complexity
      )
    }
    return complexity
  }

  getArgsFromCostMap (
    node: FieldNode,
    parentType: string,
    fieldArgs: { [argument: string]: mixed }
  ) {
    const costObject =
      this.options.costMap &&
      this.options.costMap[parentType] &&
      this.options.costMap[parentType][node.name.value]

    if (!costObject) {
      return
    }

    let { useMultipliers, multiplier, complexity, multipliers } = costObject

    // NB multiplier is deprecated
    multiplier = multiplier && selectn(multiplier, fieldArgs)

    if (typeof multipliers === 'function') {
      multipliers = multipliers.apply(this, [{ node, parentType, fieldArgs }, costObject])
    } else {
      multipliers = this.getMultipliersFromString(multipliers, fieldArgs)
    }

    if (typeof complexity === 'function') {
      complexity = complexity.apply(this, [{ node, parentType, fieldArgs }, costObject])
    }

    return {
      useMultipliers,
      multiplier,
      complexity,
      multipliers
    }
  }

  getMultipliersFromListNode (
    listNode: $ReadOnlyArray<ValueNode>,
    fieldArgs: { [argument: string]: mixed }
  ) {
    const multipliers = []
    listNode.forEach(node => {
      if (node.kind === Kind.STRING) {
        multipliers.push(node.value)
      }
    })

    return this.getMultipliersFromString(multipliers, fieldArgs)
  }

  getMultipliersFromString (
    multipliers: Array<string> = [],
    fieldArgs: { [argument: string]: mixed }
  ): Array<number> {
    // get arguments values, convert to integer and delete 0 values from list
    return multipliers
      .map(multiplier => {
        const value = selectn(multiplier, fieldArgs)

        // if the argument is an array, the multiplier will be the length of it
        if (Array.isArray(value)) {
          return value.length
        }
        return Number(value) || 0
      })
      .filter(multiplier => multiplier !== 0)
  }

  getArgsFromDirectives (
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

      const multipliersArg: ?ArgumentNode =
        costDirective.arguments &&
        costDirective.arguments.find(arg => arg.name.value === 'multipliers')

      // get arguments's values
      const useMultipliers =
        useMultipliersArg &&
        useMultipliersArg.value &&
        useMultipliersArg.value.kind === Kind.BOOLEAN
          ? useMultipliersArg.value.value
          : true

      const multipliers: Array<number> =
        multipliersArg &&
        multipliersArg.value &&
        multipliersArg.value.kind === Kind.LIST
          ? this.getMultipliersFromListNode(
            multipliersArg.value.values,
            fieldArgs
          )
          : []

      const multiplier: ?number =
        multiplierArg && multiplierArg.value.value
          ? Number(selectn(multiplierArg.value.value, fieldArgs))
          : undefined

      const complexity =
        complexityArg &&
        complexityArg.value &&
        complexityArg.value.kind === Kind.INT
          ? Number(complexityArg.value.value)
          : this.defaultComplexity

      return {
        complexity,
        multiplier,
        multipliers,
        useMultipliers
      }
    }
  }

  computeNodeCost (
    node: NodeType,
    typeDef: ?GraphQLNamedType,
    parentMultipliers: Array<number> = []
  ): number {
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

    const selections: $ReadOnlyArray<SelectionNode> = node.selectionSet.selections
    let total = 0
    let fragmentCosts = []

    for (const childNode of selections) {
      // reset the operation multipliers with parentMultipliers for each childNode
      // it resolves issue #14: https://github.com/pa-bru/graphql-cost-analysis/issues/14
      this.operationMultipliers = [...parentMultipliers]
      let nodeCost: number = this.defaultCost

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
            // ValuesOfCorrectType validation will report this
            break
          }

          // it the costMap option is set, compute the cost with the costMap provided
          // by the user.
          if (
            this.options.costMap &&
            typeof this.options.costMap === 'object'
          ) {
            const costMapArgs =
              typeDef && typeDef.name
                ? this.getArgsFromCostMap(childNode, typeDef.name, fieldArgs)
                : undefined
            nodeCost = this.computeCost(costMapArgs)
          } else {
            // Compute cost of current field with its cost directive
            let costIsComputed: boolean = false
            if (field.astNode && field.astNode.directives) {
              const directiveArgs = this.getArgsFromDirectives(
                field.astNode.directives,
                fieldArgs
              )
              nodeCost = this.computeCost(directiveArgs)

              if (directiveArgs) {
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
              const directiveArgs = this.getArgsFromDirectives(
                fieldType.astNode.directives,
                fieldArgs
              )
              nodeCost = this.computeCost(directiveArgs)
            }
          }

          let childCost = 0
          childCost = this.computeNodeCost(
            childNode,
            fieldType,
            this.operationMultipliers
          )
          nodeCost += childCost
          break
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragment = this.context.getFragment(childNode.name.value)
          const fragmentType =
            fragment &&
            this.context
              .getSchema()
              .getType(fragment.typeCondition.name.value)
          let fragmentNodeCost = fragment
            ? this.computeNodeCost(fragment, fragmentType, this.operationMultipliers)
            : this.defaultCost
          fragmentCosts.push(fragmentNodeCost)
          nodeCost = 0
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
          let fragmentNodeCost = childNode
            ? this.computeNodeCost(childNode, inlineFragmentType, this.operationMultipliers)
            : this.defaultCost
          fragmentCosts.push(fragmentNodeCost)
          nodeCost = 0
          break
        }
        default: {
          nodeCost = this.computeNodeCost(childNode, typeDef)
          break
        }
      }

      total = Math.max(nodeCost, 0) + total
    }

    if (!fragmentCosts.length) {
      return total
    }

    return total + Math.max(...fragmentCosts)
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
