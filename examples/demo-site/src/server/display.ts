import type { Display, DisplayBlock } from "@idx-kit/client";
import { PageFailure } from "./engine.ts";

export function displayBlocks(...displays: Display[]): DisplayBlock[] {
  for (const display of displays) {
    if (
      display.rulesVersion !== "1" ||
      display.siteChromeOutsideListingBody !== true ||
      !Array.isArray(display.blocks) ||
      display.blocks.length === 0
    )
      throw new PageFailure(503, "unsupported_display_rules");
    for (const block of display.blocks) {
      if (
        !["adjacent", "afterListing", "pageFooter"].includes(block.placement) ||
        !["normal", "medianListingText", "largestListingText"].includes(
          block.prominence,
        )
      )
        throw new PageFailure(503, "unsupported_display_block");
    }
  }
  return displays.flatMap((display) => display.blocks);
}
