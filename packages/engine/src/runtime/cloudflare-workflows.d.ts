// The sync Worker's Workflow APIs without Worker globals in the Node typecheck.
declare module "cloudflare:workers" {
  type StepOutput =
    | string
    | number
    | { [key: string]: StepOutput | undefined };

  export abstract class WorkflowEntrypoint<Env, Params> {
    protected readonly env: Env;
    abstract run(
      event: WorkflowEvent<Params>,
      step: WorkflowStep,
    ): Promise<StepOutput>;
  }

  export interface WorkflowEvent<Params> {
    readonly payload: Readonly<Params>;
  }

  export interface WorkflowStep {
    do<T extends StepOutput | void>(
      name: string,
      config: {
        retries: { limit: number; delay: string; backoff: "constant" };
        timeout: string;
      },
      callback: () => Promise<T>,
    ): Promise<T>;
  }
}

declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error {
    constructor(message: string);
  }
}
