/** Small text helpers shared by validation and fixtures. */
export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
