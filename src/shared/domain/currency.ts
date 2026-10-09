/**
 * ISO-4217 codes known to the runtime (ICU data shipped with Bun). Used to refuse codes that merely *look* like a
 * currency ("XYZ"); which currencies the operator actually enables is configuration (SUPPORTED_CURRENCIES).
 */
const ISO_4217 = new Set(Intl.supportedValuesOf("currency"));

export const isIso4217 = (code: string): boolean => ISO_4217.has(code);
