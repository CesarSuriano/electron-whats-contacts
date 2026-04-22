import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';

import { AppLabel, AppLabelAssignments, SUGGESTED_LABEL_COLORS } from '../models/app-label.model';

const LABELS_STORAGE_KEY = 'appLabels';
const ASSIGNMENTS_STORAGE_KEY = 'appLabelAssignments';

@Injectable({ providedIn: 'root' })
export class LabelService {
  private readonly labelsSubject = new BehaviorSubject<AppLabel[]>(this.readLabels());
  private readonly assignmentsSubject = new BehaviorSubject<AppLabelAssignments>(this.readAssignments());

  readonly labels$: Observable<AppLabel[]> = this.labelsSubject.asObservable();
  readonly assignments$: Observable<AppLabelAssignments> = this.assignmentsSubject.asObservable();

  readonly state$: Observable<{ labels: AppLabel[]; assignments: AppLabelAssignments }> = combineLatest([
    this.labels$,
    this.assignments$
  ]).pipe(
    map(([labels, assignments]) => ({ labels, assignments }))
  );

  get labels(): AppLabel[] {
    return this.labelsSubject.value;
  }

  get assignments(): AppLabelAssignments {
    return this.assignmentsSubject.value;
  }

  getLabelsForJid(jid: string): AppLabel[] {
    const ids = this.assignmentsSubject.value[jid] || [];
    if (!ids.length) {
      return [];
    }
    const byId = new Map(this.labelsSubject.value.map(label => [label.id, label]));
    return ids.map(id => byId.get(id)).filter((label): label is AppLabel => Boolean(label));
  }

  watchLabelsForJid(jid: string): Observable<AppLabel[]> {
    return this.state$.pipe(
      map(({ labels, assignments }) => {
        const ids = assignments[jid] || [];
        if (!ids.length) {
          return [];
        }
        const byId = new Map(labels.map(label => [label.id, label]));
        return ids.map(id => byId.get(id)).filter((label): label is AppLabel => Boolean(label));
      })
    );
  }

  createLabel(name: string, color?: string): AppLabel {
    const label: AppLabel = {
      id: this.generateId(),
      name: (name || '').trim() || 'Sem nome',
      color: color || this.suggestNextColor(),
      createdAt: new Date().toISOString()
    };
    this.persistLabels([...this.labelsSubject.value, label]);
    return label;
  }

  updateLabel(id: string, patch: { name?: string; color?: string }): AppLabel | null {
    const labels = this.labelsSubject.value;
    const idx = labels.findIndex(label => label.id === id);
    if (idx === -1) {
      return null;
    }
    const updated: AppLabel = {
      ...labels[idx],
      ...(patch.name !== undefined ? { name: patch.name.trim() || labels[idx].name } : {}),
      ...(patch.color !== undefined ? { color: patch.color || labels[idx].color } : {})
    };
    const next = [...labels];
    next[idx] = updated;
    this.persistLabels(next);
    return updated;
  }

  removeLabel(id: string): void {
    this.persistLabels(this.labelsSubject.value.filter(label => label.id !== id));

    const assignments = { ...this.assignmentsSubject.value };
    let changed = false;
    Object.keys(assignments).forEach(jid => {
      const filtered = assignments[jid].filter(labelId => labelId !== id);
      if (filtered.length !== assignments[jid].length) {
        changed = true;
        if (filtered.length) {
          assignments[jid] = filtered;
        } else {
          delete assignments[jid];
        }
      }
    });

    if (changed) {
      this.persistAssignments(assignments);
    }
  }

  setJidLabels(jid: string, labelIds: string[]): void {
    const assignments = { ...this.assignmentsSubject.value };
    const unique = Array.from(new Set(labelIds));
    if (unique.length) {
      assignments[jid] = unique;
    } else {
      delete assignments[jid];
    }
    this.persistAssignments(assignments);
  }

  toggleLabelOnJid(jid: string, labelId: string): void {
    const current = this.assignmentsSubject.value[jid] || [];
    if (current.includes(labelId)) {
      this.setJidLabels(jid, current.filter(id => id !== labelId));
    } else {
      this.setJidLabels(jid, [...current, labelId]);
    }
  }

  applyLabelToJids(labelId: string, jids: string[], add: boolean): void {
    if (!jids.length) {
      return;
    }
    const assignments = { ...this.assignmentsSubject.value };
    let changed = false;
    for (const jid of jids) {
      const current = assignments[jid] || [];
      const has = current.includes(labelId);
      if (add && !has) {
        assignments[jid] = [...current, labelId];
        changed = true;
      } else if (!add && has) {
        const next = current.filter(id => id !== labelId);
        if (next.length) {
          assignments[jid] = next;
        } else {
          delete assignments[jid];
        }
        changed = true;
      }
    }
    if (changed) {
      this.persistAssignments(assignments);
    }
  }

  countJidsWithLabel(labelId: string, jids: string[]): number {
    let n = 0;
    const assignments = this.assignmentsSubject.value;
    for (const jid of jids) {
      if ((assignments[jid] || []).includes(labelId)) {
        n++;
      }
    }
    return n;
  }

  suggestNextColor(): string {
    const used = new Set(this.labelsSubject.value.map(label => label.color.toLowerCase()));
    for (const color of SUGGESTED_LABEL_COLORS) {
      if (!used.has(color.toLowerCase())) {
        return color;
      }
    }
    return SUGGESTED_LABEL_COLORS[this.labelsSubject.value.length % SUGGESTED_LABEL_COLORS.length];
  }

  private readLabels(): AppLabel[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }
    try {
      const raw = localStorage.getItem(LABELS_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private readAssignments(): AppLabelAssignments {
    if (typeof localStorage === 'undefined') {
      return {};
    }
    try {
      const raw = localStorage.getItem(ASSIGNMENTS_STORAGE_KEY);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private persistLabels(labels: AppLabel[]): void {
    this.labelsSubject.next(labels);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LABELS_STORAGE_KEY, JSON.stringify(labels));
    }
  }

  private persistAssignments(assignments: AppLabelAssignments): void {
    this.assignmentsSubject.next(assignments);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ASSIGNMENTS_STORAGE_KEY, JSON.stringify(assignments));
    }
  }

  private generateId(): string {
    return `lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
