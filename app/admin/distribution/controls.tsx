"use client";

import { useState } from "react";
import { queueCatchUpTeaser, retryQueuedTeasers } from "../actions";
import { Button } from "@/components/ui/button";

export function DistributionControls() {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(action: () => Promise<{ ok: boolean; message: string }>) {
    setPending(true);
    try {
      const result = await action();
      setMessage(result.message);
    } catch {
      setMessage("That action could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid max-w-xl gap-3">
      <Button
        type="button"
        disabled={pending}
        onClick={() => void run(queueCatchUpTeaser)}
      >
        Send the one latest confirmed article
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() => void run(retryQueuedTeasers)}
      >
        Retry queued handoffs
      </Button>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
    </div>
  );
}
