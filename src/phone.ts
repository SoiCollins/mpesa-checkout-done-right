/**
 * Normalise a Kenyan mobile number to the 2547XXXXXXXX / 2541XXXXXXXX form Daraja expects.
 * Accepts 07.., 01.., 7.., 1.., +254.., 254.. with spaces or dashes.
 * Returns null for anything that isn't a Kenyan mobile number.
 */
export function normaliseKenyanMsisdn(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;

  let local: string;
  if (digits.startsWith("254")) local = digits.slice(3);
  else if (digits.startsWith("0")) local = digits.slice(1);
  else local = digits;

  if (!/^[17]\d{8}$/.test(local)) return null;
  return `254${local}`;
}
