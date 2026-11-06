import { readFile } from "node:fs/promises";
import type { FixtureRecord } from "../domain/normalize.ts";
import type { DisplayBlock } from "@idx-kit/client";

export interface Fixtures {
  feeds: {
    id: string;
    refreshedAt: string;
    expiresAt: string;
    blocks: DisplayBlock[];
    rulesVersion: string;
  }[];
  sites: { id: string; feedIds: string[] }[];
  listings: FixtureRecord[];
}
export class FixtureConnector {
  readonly directory: URL;
  constructor(directory = new URL("../../../../fixtures/", import.meta.url)) {
    this.directory = directory;
  }
  async read(): Promise<Fixtures> {
    const read = async (name: string) =>
      JSON.parse(await readFile(new URL(name, this.directory), "utf8"));
    const [feeds, sites, listings] = await Promise.all(
      ["feeds.json", "sites.json", "listings.json"].map(read),
    );
    return { feeds, sites, listings };
  }
}
