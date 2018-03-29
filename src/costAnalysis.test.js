import {
  parse,
  TypeInfo,
  ValidationContext,
  visit,
  visitWithTypeInfo
} from 'graphql'
import { makeExecutableSchema } from 'graphql-tools'
import CostAnalysis from './costAnalysis'

const customCost = 8
const firstComplexity = 2
const secondComplexity = 5
const thirdComplexity = 6
const fourthComplexity = 4

const typeDefs = `
  interface BasicInterface {
    string: String
    int: Int
  }

  type Query {
    defaultCost: Int
    costWithoutMultipliers: Int @cost(useMultipliers: false, complexity: ${customCost})
    customCost: Int @cost(useMultipliers: false, complexity: ${customCost})
    badComplexityArgument: Int @cost(complexity: 12)
    customCostWithResolver(limit: Int): Int @cost(
      multipliers: ["limit"], useMultipliers: true, complexity: ${fourthComplexity}
    )

    # for recursive cost
    first (limit: Int): First @cost(
      multipliers: ["limit"], useMultipliers: true, complexity: ${firstComplexity}
    )

    severalMultipliers(first: Int, last: Int, list: [String]): Int @cost(
      multipliers: ["coucou", "first", "last", "list"], useMultipliers: true, complexity: ${fourthComplexity}
    )

    overrideTypeCost: TypeCost @cost(complexity: 2)
    getCostByType: TypeCost
  }

  type First implements BasicInterface {
    string: String
    int: Int
    second (limit: Int): Second @cost(
      multipliers: ["limit"], useMultipliers: true, complexity: ${secondComplexity}
    )
  }

  type Second implements BasicInterface {
    string: String
    int: Int
    third (limit: Int): String @cost(
      multipliers: ["limit"], useMultipliers: true, complexity: ${thirdComplexity}
    )
  }

  type TypeCost @cost(complexity: 3) {
    string: String
    int: Int
  }

  schema {
    query: Query
  }
`

const resolvers = {
  Query: {
    defaultCost: () => 1,
    customCost: () => 2,
    customCostWithResolver: (root, { limit }, context) => limit,
    first: (root, { limit }, context) => ({
      string: 'first',
      int: 1
    })
  }
}

const schema = makeExecutableSchema({ typeDefs, resolvers })

describe('Cost analysis Tests', () => {
  const typeInfo = new TypeInfo(schema)

  test('should consider default cost', () => {
    const ast = parse(`
      query {
        defaultCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(0)
  })

  test('should enable to set the value of the default cost', () => {
    const defaultCost = 12
    const ast = parse(`
      query {
        defaultCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100,
      defaultCost
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(defaultCost)
  })

  test('should consider custom scalar cost', () => {
    const ast = parse(`
      query {
        customCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(customCost)
  })

  test('should consider recursive cost computation', () => {
    const limit = 10
    const ast = parse(`
      query {
        first(limit: ${limit}) {
          second(limit: ${limit}) {
            third(limit: ${limit})
          }
        }
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 10000
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))

    const firstCost = limit * firstComplexity
    const secondCost = limit * limit * secondComplexity
    const thirdCost = limit * limit * limit * thirdComplexity

    const result = firstCost + secondCost + thirdCost
    expect(visitor.cost).toEqual(result)
    expect(visitor.operationMultipliers).toEqual([limit, limit, limit])
  })

  test(`should consider recursive cost computation + empty multipliers array when the node is of kind operation definition`, () => {
    const limit = 10
    const ast = parse(`
        query {
          first(limit: ${limit}) {
            second(limit: ${limit}) {
              third(limit: ${limit})
            }
          }
          customCost
        }
      `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 10000
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))

    const firstCost = limit * firstComplexity
    const secondCost = limit * limit * secondComplexity
    const thirdCost = limit * limit * limit * thirdComplexity

    const result = firstCost + secondCost + thirdCost + customCost
    expect(visitor.cost).toEqual(result)
    // visitor.operationMultipliers should be empty at the end
    // because customCost is another node in the Query type
    // and customCost has no multipliers arg itself
    expect(visitor.operationMultipliers).toEqual([])
  })

  test('should report error if the maximum cost is reached', () => {
    const ast = parse(`
      query {
        customCost
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 1
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))

    expect(context.getErrors().length).toEqual(1)
    expect(context.getErrors()[0].message).toEqual(
      `The query exceeds the maximum cost of 1. Actual cost is ${customCost}`
    )
  })

  test('should not allow negative cost', () => {
    const ast = parse(`
      query {
        customCostWithResolver(limit: -10)
      }
    `)

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(0)
  })

  test(
    'a cost directive defined on a field should override ' +
      'the cost directive defined on the type definition',
    () => {
      const ast = parse(`
      query {
        overrideTypeCost
      }
    `)

      const context = new ValidationContext(schema, ast, typeInfo)
      const visitor = new CostAnalysis(context, {
        maximumCost: 100
      })

      visit(ast, visitWithTypeInfo(typeInfo, visitor))
      expect(visitor.cost).toEqual(2)
    }
  )

  test(
    'if a field returns a specific type and the type has a cost directive and ' +
      'the field does not have a cost directive, the cost will be of that type',
    () => {
      const ast = parse(`
      query {
        getCostByType
      }
    `)

      const context = new ValidationContext(schema, ast, typeInfo)
      const visitor = new CostAnalysis(context, {
        maximumCost: 100
      })

      visit(ast, visitWithTypeInfo(typeInfo, visitor))
      expect(visitor.cost).toEqual(3)
    }
  )

  test('if costMap option is provided, we compute the score with it', () => {
    const limit = 15
    const ast = parse(`
      query {
        first(limit: ${limit})
      }
    `)

    const costMap = {
      Query: {
        first: {
          useMultipliers: true,
          complexity: 3,
          multipliers: ['limit']
        }
      }
    }

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100,
      costMap
    })
    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    const expectedCost = costMap.Query.first.complexity * limit
    expect(visitor.cost).toEqual(expectedCost)
  })

  test('if costMap node is undefined, return the defaultCost', () => {
    const ast = parse(`
      query {
        first(limit: 10)
      }
    `)

    const costMap = {}
    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 100,
      costMap
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(visitor.cost).toEqual(visitor.defaultCost)
  })

  test('should be able to add a custom complexity range and return an error if a complexity does not respect our range', () => {
    const ast = parse(`
      query {
        badComplexityArgument
      }
    `)

    const min = 1
    const max = 3

    const context = new ValidationContext(schema, ast, typeInfo)
    const visitor = new CostAnalysis(context, {
      maximumCost: 1000,
      complexityRange: {
        min,
        max
      }
    })

    visit(ast, visitWithTypeInfo(typeInfo, visitor))
    expect(context.getErrors().length).toEqual(1)
    expect(context.getErrors()[0].message).toEqual(
      `The complexity argument must be between ${min} and ${max}`
    )
    expect(visitor.cost).toEqual(visitor.defaultCost)
  })

  test('assert complexityRange.min and complexityRange.max are valid', () => {
    const ast = parse(`
      query {
        badComplexityArgument
      }
    `)

    const min = 100
    const max = 1
    const context = new ValidationContext(schema, ast, typeInfo)

    // min > max should throw an error
    expect(() => {
      const visitor = new CostAnalysis(context, {
        maximumCost: 1000,
        complexityRange: {
          min,
          max
        }
      })
      visit(ast, visitWithTypeInfo(typeInfo, visitor))
    }).toThrow('Invalid minimum and maximum complexity')

    // omitting min or max properties should throw an error
    expect(() => {
      const visitor = new CostAnalysis(context, {
        maximumCost: 1000,
        complexityRange: {}
      })
      visit(ast, visitWithTypeInfo(typeInfo, visitor))
    }).toThrow('Invalid minimum and maximum complexity')
  })

  test(
    `Assert fields in the multipliers array property are added together and then multiplicated ` +
      `by the complexity and the parent multipliers (if useMultipliers === true)`,
    () => {
      const first = 10
      const last = 4
      const ast = parse(`
        query {
          severalMultipliers(first: ${first}, last: ${last})
        }
      `)

      const context = new ValidationContext(schema, ast, typeInfo)
      const visitor = new CostAnalysis(context, {
        maximumCost: 1000
      })
      visit(ast, visitWithTypeInfo(typeInfo, visitor))
      const expectedCost = fourthComplexity * (first + last)
      expect(visitor.cost).toEqual(expectedCost)
    }
  )

  if (process.env.NODE_ENV !== 'production') {
    test('Using the DEPRECATED field `multiplier` should log a warning.', () => {
      const limit = 15
      const ast = parse(`
        query {
          first(limit: ${limit})
        }
      `)

      const costMap = {
        Query: {
          first: {
            multiplier: 'limit',
            useMultipliers: true,
            complexity: 3
          }
        }
      }

      const context = new ValidationContext(schema, ast, typeInfo)
      const visitor = new CostAnalysis(context, {
        maximumCost: 100,
        costMap
      })
      const warn = jest.spyOn(global.console, 'warn')

      visit(ast, visitWithTypeInfo(typeInfo, visitor))
      const expectedCost = costMap.Query.first.complexity * limit
      expect(visitor.cost).toEqual(expectedCost)
      // should log a warning about the deprecated field 'multiplier'
      expect(warn).toHaveBeenCalled()
    })
  }

  test(
    `Assert a query argument of type GraphQLList added in a multipliers array ` +
      `will have its length for its multiplier value `,
    () => {
      const first = 10
      const last = 4
      const list = ['this', 'is', 'a', 'test']
      const ast = parse(`
        query {
          severalMultipliers(first: ${first}, last: ${last}, list: ["this", "is", "a", "test"])
        }
      `)

      const context = new ValidationContext(schema, ast, typeInfo)
      const visitor = new CostAnalysis(context, {
        maximumCost: 1000
      })
      visit(ast, visitWithTypeInfo(typeInfo, visitor))
      const expectedCost = fourthComplexity * (first + last + list.length)
      expect(visitor.cost).toEqual(expectedCost)
    }
  )
})
