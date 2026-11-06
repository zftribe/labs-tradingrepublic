import { readMirrorConfig } from "@/lib/distribution/event";
import { DistributionControls } from "./controls";

export const metadata = { title: "Public teasers" };

export default function DistributionPage() {
  const config = readMirrorConfig(process.env);
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="mb-3 font-display text-2xl font-bold">Public teasers</h1>
      <div className="mb-6 grid gap-2 text-sm text-muted-foreground">
        <p>
          Labs has no membership or paywall. Authors choose, per article, whether
          a short public teaser may be handed off the first time a draft is
          published. The default is not classified, and that is not eligible.
        </p>
        <p>
          Delivery configured: {config.enabled ? "yes" : "no"}. Catch-up flag:{" "}
          {config.catchupEnabled ? "on" : "off"}. Publishing an author-confirmed
          public article attempts the handoff in that request. This page does
          not send every article. Retry is only for an unconsumed attempt still
          inside five minutes. A response that was not recognized is held and is
          not sent again. Nothing here confirms a chat post, and a teaser that
          was already handed off cannot be recalled.
        </p>
        <p>
          The catch-up button selects the newest author-confirmed public article
          and attempts that one handoff. It does not select an older article.
        </p>
      </div>
      <DistributionControls />
    </main>
  );
}
