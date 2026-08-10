import type { Model, ModelRequest, ModelTurn } from "../model/Model.js";

export class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];

  /**
   * Creates a model that consumes supplied turns in order.
   *
   * @param turns - Predetermined model turns for future invocations.
   */
  constructor(private readonly turns: ModelTurn[]) {}

  /**
   * Records one request and returns the next scripted turn.
   *
   * @param request - Provider-neutral request made by the orchestrator.
   * @returns The next predetermined model turn.
   */
  async invoke(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.turns.shift();

    if (turn === undefined) {
      throw new Error("ScriptedModel has no turn remaining");
    }

    return turn;
  }
}
