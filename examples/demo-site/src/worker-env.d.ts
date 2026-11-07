interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
  readonly IDX_WORKER?: boolean;
}

declare module "cloudflare:workers" {
  export const env: {
    IDX_ENGINE: { fetch: typeof fetch };
    IDX_SECRET_KEY: string;
  };
}
