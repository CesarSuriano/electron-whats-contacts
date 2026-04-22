export interface AppLabel {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface AppLabelAssignments {
  [jid: string]: string[];
}

export const SUGGESTED_LABEL_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#22c55e', // green
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#64748b', // slate
  '#0f172a'  // ink
];
