export const LASER_SEPARATION_PENDING = 'pending';
export const LASER_SEPARATION_PAID = 'paid';
export const LASER_SEPARATION_OPTIONS = [
  { value: LASER_SEPARATION_PENDING, label: 'Pendente de separação', className: 'laser-separation-pending' },
  { value: LASER_SEPARATION_PAID, label: 'Pago', className: 'laser-separation-paid' },
  { value: 'reschedule', label: 'Reprogramar', className: 'laser-separation-reschedule' },
  { value: 'missing_material', label: 'Falta de MP', className: 'laser-separation-missing-material' },
  { value: 'awaiting_pcp', label: 'Aguardando PCP', className: 'laser-separation-awaiting-pcp' },
];

export function separationKey(machine, program) {
  return JSON.stringify([machine, program]);
}

export function validSeparationUpdate(value) {
  return value && typeof value === 'object'
    && typeof value.machine === 'string' && value.machine.trim().length > 0
    && value.machine.length <= 200
    && typeof value.program === 'string' && value.program.trim().length > 0
    && value.program.length <= 200
    && LASER_SEPARATION_OPTIONS.some((option) => option.value === value.status);
}
