# GraphQL Query Cost Analysis for graphql-js

[![Travis][build-badge]][build]
[![npm version][npm-badge]][npm]

A GraphQL request cost analyzer.

This can be used to protect your GraphQL servers against DoS attacks, compute the data consumption per user and limit it.

This package parses the request content and computes its cost with your GraphQL server cost configuration.

Backend operations have different complexities and dynamic arguments (like a limit of items to retrieve).
With this package you can define a cost setting on each GraphQL field/type with **directives** or a **Type Map Object**.

Works with [graphql-js] reference implementation

**Type Map Object**: An object containing types supported by your GraphQL server.

## Installation

Install the package with npm

```sh
$ npm install --save graphql-cost-analysis
```

## Simple Setup

Init the cost analyzer

```javascript
import costAnalysis from 'graphql-cost-analysis'

const costAnalyzer = costAnalysis({
  maximumCost: 1000,
})
```

Then add the validation rule to the GraphQL server ([apollo-server], [express-graphql]...)

**Setup with express-graphql**

```javascript
app.use(
  '/graphql',
  graphqlHTTP((req, res, graphQLParams) => ({
    schema: MyGraphQLSchema,
    graphiql: true,
    validationRules: [
      costAnalysis({
        variables: graphQLParams.variables,
        maximumCost: 1000,
      }),
    ],
  }))
)
```

**Setup with apollo-server-express**

```javascript
app.use(
  '/graphql',
  graphqlExpress(req => {
    return {
      schema,
      rootValue: null,
      validationRules: [
        costAnalysis({
          variables: req.body.variables,
          maximumCost: 1000,
        }),
      ],
    }
  })
)
```

## costAnalysis Configuration

The `costAnalysis` function accepts the following options:

| Argument                       | Description                                                                                                                                                                                                                                                                              | Type                               | Default   | Required |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------- | -------- |
| maximumCost                    | The maximum allowed cost. Queries above this threshold will be rejected.                                                                                                                                                                                                                 | Int                                | undefined | yes      |
| variables                      | The query variables. This is needed because the variables are not available in the visitor of the graphql-js library.                                                                                                                                                                    | Object                             | undefined | no       |
| defaultCost                    | Fields without cost setting will have this default value.                                                                                                                                                                                                                                | Int                                | 0         | no       |
| costMap                        | A Type Map Object where you can define the cost setting of each field without adding cost directives to your schema. <br>If this object is defined, cost directives will be ignored.<br>Each field in the Cost Map Object can have 3 args: `multiplier`, `useMultipliers`, `complexity`. | Object                             | undefined | no       |
| complexityRange                | An optional object defining a range the complexity must respect. It throws an error if it's not the case.                                                                                                                                                                                | Object: {min: number, max: number} | undefined | no       |
| onComplete(cost)               | Callback function to retrieve the determined query cost. It will be invoked whether the query is rejected or not. <br>This can be used for logging or to implement rate limiting (for example, to store the cost by session and define a max cost the user can have in a specific time). | Function                           | undefined | no       |
| createError(maximumCost, cost) | Function to create a custom error.                                                                                                                                                                                                                                                       | Function                           | undefined | no       |

## A Custom Cost for Each Field/Type

Now that your global configuration is set, you can define the cost calculation for each of your schema Field/Type.

2 Ways of defining Field/Type cost settings:

* with a `@cost` directive
* by passing a Type Map Object to the `costAnalysis` function (see `costMap` argument)

### Cost Settings Arguments:

| Argument       | Description                                                                                                                                                                                                                                                                             | Type                  | Default   | Required |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------- | -------- |
| multiplier     | The name of a parameter present in the GraphQL field. Use this parameter's value to compute the field's cost dynamically. <br>E.g: GraphQL field is `getUser(filters: {limit: 5})`. The mutliplier could be `"filters.limit"`.                                                          | String                | undefined | no       |
| useMultipliers | Defines if the field's cost depends on the parent multipliers.                                                                                                                                                                                                                          | Boolean               | true      | no       |
| complexity     | The level of complexity to resolve the current field. <br>If the field needs to call an expensive service to resolve itself, then the complexity should be at a high level but if the field is easy to resolve and not an expensive operation, the complexity should be at a low level. | Int (min: 1; max: 10) | 1         | no       |

## Defining the Cost Settings via Directives

To define the cost settings of fields for which you want a custom cost calculation, just add a `cost` directive to the concerned fields directly to your GraphQL schema.

**Example:**

```graphql
# you can define a cost directive on a type
type TypeCost @cost(complexity: 3) {
  string: String
  int: Int
}

type Query {
  # will have the default cost value
  defaultCost: Int

  # will have a cost of 2 because this field does not depend on its parent fields
  customCost: Int @cost(useMultipliers: false, complexity: 2)

  # complexity should be between 1 and 10
  badComplexityArgument: Int @cost(complexity: 12)

  # the cost will depend on the `limit` parameter passed to the field
  # then the multiplier will be added to the `multipliers` array
  customCostWithResolver(limit: Int): Int @cost(multiplier: "limit", complexity: 4)

  # for recursive cost
  first (limit: Int): First @cost(
    multiplier: "limit", useMultipliers: true, complexity: ${firstComplexity}
  )

  # you can override the cost setting defined directly on a type
  overrideTypeCost: TypeCost @cost(complexity: 2)
  getCostByType: TypeCost
}

type First {
  # will have the default cost value
  myString: String

  # the cost will depend on the `limit` value passed to the field and the value of `complexity`
  # and the parent multipliers args: here the `limit` value of the `Query.first` field
  second (limit: Int): String @cost(multiplier: "limit", complexity: 2)

  # the cost will be 1 * `multiplier` (1 is the default complexity and `useMultipliers` is false)
  costWithoutMultipliers (limit: Int): Int @cost(useMultipliers: false, multiplier: "limit")
}
```

## Defining the Cost Settings in a Type Map Object

> Use a Type Map Object when you don't want to contaminate your GraphQL schema definition, so every cost setting field will be reported in a specific object.
>
> If you dispatch your GraphQL schema in several modules, you can divide your Cost Map Object into several objects to put them in their specific modules and then merge them into one Cost Map that you can pass to the `costAnalysis` function.

Create a type Map Object representing your GraphQL schema and pass cost settings to each field for which you want a custom cost.

**Example:**

```javascript
const myCostMap = {
  Query: {
    first: {
      multiplier: 'limit',
      useMultipliers: true,
      complexity: 3,
    },
  },
}

app.use(
  '/graphql',
  graphqlHTTP({
    schema: MyGraphQLSchema,
    validationRules: [
      costAnalysis({
        maximumCost: 1000,
        costMap: myCostMap,
      }),
    ],
  })
)
```

## Note

If you just need a simple query complexity analysis (without multipliers or depth of parent multipliers), I suggest you install [graphql-query-complexity]

## License

graphql-cost-analysis is [MIT-licensed].

[build-badge]: https://travis-ci.org/pa-bru/graphql-cost-analysis.svg?branch=master
[build]: https://travis-ci.org/pa-bru/graphql-cost-analysis
[npm-badge]: https://img.shields.io/npm/v/graphql-cost-analysis.svg
[npm]: https://www.npmjs.com/package/graphql-cost-analysis
[graphql-js]: https://github.com/graphql/graphql-js
[express-graphql]: https://github.com/graphql/express-graphql
[apollo-server]: https://github.com/apollographql/apollo-server
[graphql-query-complexity]: https://github.com/ivome/graphql-query-complexity
[mit-licensed]: (https://github.com/pa-bru/graphql-cost-analysis/blob/master/LICENSE)
