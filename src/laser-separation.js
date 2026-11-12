export const LASER_SEPARATION_PENDING = 'pending';
export const LASER_SEPARATION_PAID = 'paid';

export function separationKey(machine, program) {
  return JSON.stringify([machine, program]);
}

export function validSeparationUpdate(value) {
  return value && typeof value === 'object'
    && typeof value.machine === 'string' && value.machine.trim().length > 0
    && value.machine.length <= 200
    && typeof value.program === 'string' && value.program.trim().length > 0
    && value.program.length <= 200
    && [LASER_SEPARATION_PENDING, LASER_SEPARATION_PAID].includes(value.status);
}
