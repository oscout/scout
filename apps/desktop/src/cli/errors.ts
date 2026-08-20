export class ScoutCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoutCliError";
  }
}
