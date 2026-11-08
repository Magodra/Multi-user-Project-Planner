/** Status indicators (CLAUDE.md §7): internal/external, MONITOR/AGREEMENT, pending, rejected, variance. */
import type { AgreementState, LinkType } from "@planning/shared";

export interface StatusBadge {
  label: string;
  title: string;
  className: string;
}

/** A plan using an external task, as named in the owner plan. */
export interface TaskRecipient {
  name: string;
  linkType: LinkType;
}

const AGREEMENT_TITLE = "AGREEMENT link: changes need approval of all parties";
const MONITOR_TITLE = "MONITOR link: changes are notified";

export const PENDING_BADGE: StatusBadge = {
  label: "PEND",
  title: "Pending approval",
  className: "pp-b-pending",
};

export function itemBadges(input: {
  external: boolean;
  /** Plans using this external task, with the type of each use. */
  recipients: TaskRecipient[];
  reference: boolean;
  linkType: LinkType | null;
  pending: boolean;
  agreementState: AgreementState;
  endVarianceDays: number | null;
  /** Explanations of dependencies this task does not respect. */
  dependencyIssues?: string[];
}): StatusBadge[] {
  const badges: StatusBadge[] = [];
  if (input.reference) {
    badges.push({
      label: "REF",
      title: "External task owned by another plan",
      className: "pp-b-ref",
    });
    if (input.linkType === "AGREEMENT")
      badges.push({
        label: "AGR",
        title: AGREEMENT_TITLE,
        className: "pp-b-agreement",
      });
    else
      badges.push({
        label: "MON",
        title: MONITOR_TITLE,
        className: "pp-b-monitor",
      });
  } else if (input.external) {
    badges.push({
      label: `EXT${input.recipients.length ? ` ${input.recipients.length}` : ""}`,
      title:
        input.recipients.length === 0
          ? "External task, not used in other plans yet"
          : [
              `External task used in ${input.recipients.length} other plan(s):`,
              ...input.recipients.map((r) => `• ${r.name}`),
            ].join("\n"),
      className: "pp-b-ext",
    });
    // One task can be AGREEMENT towards one plan and MONITOR towards another.
    const linkBadge = (
      linkType: LinkType,
      label: string,
      title: string,
      className: string,
    ): void => {
      const plans = input.recipients.filter((r) => r.linkType === linkType);
      if (plans.length > 0)
        badges.push({
          label,
          title: [title, ...plans.map((r) => `• ${r.name}`)].join("\n"),
          className,
        });
    };
    linkBadge("AGREEMENT", "AGR", AGREEMENT_TITLE, "pp-b-agreement");
    linkBadge("MONITOR", "MON", MONITOR_TITLE, "pp-b-monitor");
  }
  if (input.dependencyIssues?.length)
    badges.push({
      label: "⚠ DEP",
      title: input.dependencyIssues.join("\n"),
      className: "pp-b-late",
    });
  if (input.pending) badges.push(PENDING_BADGE);
  if (input.agreementState === "REJECTED")
    badges.push({ label: "REJ", title: "Agreement rejected", className: "pp-b-rejected" });
  else if (input.agreementState === "PROPOSED")
    badges.push({
      label: "PROP",
      title: "Proposed, awaiting agreement",
      className: "pp-b-pending",
    });
  else if (input.agreementState === "AGREED")
    badges.push({ label: "✓", title: "Agreed", className: "pp-b-agreed" });
  if (input.endVarianceDays) {
    const late = input.endVarianceDays > 0;
    badges.push({
      label: `${late ? "+" : ""}${input.endVarianceDays}d`,
      title: `${Math.abs(input.endVarianceDays)} day(s) ${late ? "later" : "earlier"} than agreed`,
      className: late ? "pp-b-late" : "pp-b-early",
    });
  }
  return badges;
}
