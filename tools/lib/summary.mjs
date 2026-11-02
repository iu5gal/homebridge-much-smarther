/**
 * One line describing a thermostat state, for the development tools.
 * @param {import('@much-smarther/core').ThermostatState} state
 */
export function summarise(state) {
  const parts = [
    `mode=${state.mode ?? '?'}`,
    `function=${state.function ?? '?'}`,
    `setpoint=${state.setpoint ?? '?'}`,
    `ambient=${state.ambientTemperature ?? '?'}`,
    `humidity=${state.humidity ?? '?'}`,
    `heating=${state.heatingActive ?? '?'}`,
    `program=${state.programNumber ?? '?'}`,
  ];
  if (state.boostMinutes !== undefined) parts.push(`boost=${state.boostMinutes}`);
  if (state.validity) parts.push(`validity=${state.validity.start ?? '?'}..${state.validity.end ?? '?'}`);
  return parts.join(' ');
}
