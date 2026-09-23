export class ApiweldError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ApiweldError";
    this.exitCode = exitCode;
  }
}
