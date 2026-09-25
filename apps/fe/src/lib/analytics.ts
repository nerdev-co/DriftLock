type EventName =
    | "landing_view"
    | "install_clicked"
    | "github_cta_clicked"
    | "try_sample_view"
    | "try_sample_run"
    | "confidence_explained_open"
    | "drift_card_view"
    | "repos_selected";

interface EventProps {
    [key: string]: string | number | boolean | undefined;
}

function emit(name: EventName, props?: EventProps) {
    // P0: log-only instrumentation. Swap console for PostHog / tiny API later.
    // Buy analytics, do not build pipeline yet.
    if (typeof window !== "undefined") {
        console.debug(`[analytics] ${name}`, props ?? {});
        // Future: window.posthog?.capture(name, props);
        // Future: fetch(`${BASE}/api/analytics`, { method: "POST", body: JSON.stringify({ name, props }) })
        try {
            window.dispatchEvent(new CustomEvent("driftlock:analytics", { detail: { name, props } }));
        } catch {
            // Instrumentation must never affect the product: a listener that
            // throws, or a CustomEvent constructor unavailable in this runtime,
            // should not break the interaction that emitted the event.
        }
    }
}

export function track(name: EventName, props?: EventProps) {
    emit(name, props);
}

export function useTrackOnMount(name: EventName, props?: EventProps) {
    // Intentionally not a hook — caller uses useEffect
    return { name, props };
}
