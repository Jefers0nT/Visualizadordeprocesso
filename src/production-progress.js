export function totalReported(step) {
  return step.reported + (step.reworkQty ?? 0) + (step.scrapQty ?? 0);
}
