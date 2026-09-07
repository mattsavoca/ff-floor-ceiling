export const MIN_SIMULATIONS = 100;
export const MAX_SIMULATIONS = 1_000;
export const SIMULATION_STEP = 100;
export const DEFAULT_SIMULATION_COUNT = MAX_SIMULATIONS;

export function isValidSimulationCount(value: number) {
  return Number.isInteger(value)
    && value >= MIN_SIMULATIONS
    && value <= MAX_SIMULATIONS
    && value % SIMULATION_STEP === 0;
}
