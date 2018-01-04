// @flow
import CostAnalysis from './costAnalysis'
import type { CostAnalysisOptions } from './CostAnalysis'
import type {
  ValidationContext
} from 'graphql'

export default function createCostAnalysis (options: CostAnalysisOptions): Function {
  return (context: ValidationContext): CostAnalysis => new CostAnalysis(context, options)
}
