export class DeskError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DeskError';
    this.status = status;
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
