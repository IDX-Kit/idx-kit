// The Workflow APIs used by the sync Worker, without Worker globals in Node.
declare module "cloudflare:workers" {
  export abstract class WorkflowEntrypoint<Env, Params> {
    protected readonly env: Env;
    abstract run(
      event: WorkflowEvent<Params>,
      step: WorkflowStep,
    ): Promise<unknown>;
  }

  export interface WorkflowEvent<Params> {
    readonly payload: Readonly<Params>;
  }

  export interface WorkflowStep {
    do<T>(
      name: string,
      config: {
        retries: { limit: number; delay: string; backoff: "constant" };
        timeout: string;
      },
      callback: () => Promise<T>,
    ): Promise<T>;
  }
}
