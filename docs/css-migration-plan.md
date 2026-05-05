# Plano de migração CSS

> Status: **`styles.scss` é hoje 25 linhas** (era 1243). Tudo restante é entry-point com `@import` das partials. Próxima evolução: criar componentes Angular compartilhados (`<app-button>`, `<app-card>` etc).

## Estado atual

```
src/
├── styles.scss                          ← 25 linhas, só @tailwind + @import
└── styles/                              ← partials globais
    ├── _tokens.scss        (vars CSS theme-aware: bg, surface, accent, wa-*)
    ├── _reset.scss         (preflight manual: box-sizing, html/body, font-inherit)
    ├── _buttons.scss       (.btn + variantes: primary/ghost/outline/danger/sm/icon)
    ├── _cards.scss         (.card + .card-header/title/subtitle)
    ├── _chips.scss         (.badge*, .pill*, .seg*)
    ├── _inputs.scss        (.input, .input-group, .sort-arrow, .action-icon)
    ├── _loading.scss       (.loading-state, .loading-spinner + keyframes)
    ├── _modal-shared.scss  (.modal-backdrop, .modal-close, .config-menu-item/icon)
    ├── _app-toast.scss     (.app-toast + keyframes + responsivo)
    └── _home.scss          (.home-* — global porque é compartilhado entre
                             home.component e home-dashboard-section)
```

Componentes que receberam estilos migrados:
- [`upload-xml-modal.component.scss`](../src/app/components/upload-xml-modal/upload-xml-modal.component.scss) — `.upload-*`, `.hidden-file-input`
- [`about-modal.component.scss`](../src/app/components/about-modal/about-modal.component.scss) — wrapper `.about-modal`, `.about-modal-content`
- [`app-page-header.component.scss`](../src/app/components/app-page-header/app-page-header.component.scss) — `.header-config-wrapper`, `.header-config-menu`
- [`conversation-list.component.scss`](../src/app/modules/whatsapp/components/conversation-list/conversation-list.component.scss) — todos os `.conversation-list__*`
- [`message-template-modal.component.scss`](../src/app/components/message-template-modal/message-template-modal.component.scss) — `.message-template-*`, `.emoji-btn*`, `.toolbar-icon`

Código morto deletado: `.app-header`, `.header-left/center/right`, `.logo`, `.app-title`, `.legend-*`, `.wa-labels-*`, `.tabs-image-row` — não eram referenciados em nenhum HTML/TS.

## Próxima evolução: componentes Angular compartilhados

Hoje `_buttons.scss`, `_cards.scss`, `_chips.scss`, `_inputs.scss` e `_loading.scss` são utility classes globais. Cada uma é candidata a virar um componente Angular standalone com API tipada. **Não migrei agora porque cada um exige tocar 20-30+ HTMLs do projeto** — vale fazer um por vez como PR isolada.

Ordem sugerida (por ROI):

### 1. `<app-button>` — alto ROI

`.btn` é a classe mais usada e a mais sujeita a inconsistências. Hoje você escreve:

```html
<button class="btn btn-primary btn-sm" [disabled]="loading">
  <span class="loading-spinner" *ngIf="loading"></span>
  <span class="btn-icon-symbol material-symbols-outlined">save</span>
  Salvar
</button>
```

Com componente:

```html
<app-button variant="primary" size="sm" icon="save" [loading]="loading">
  Salvar
</app-button>
```

API sugerida:

```ts
@Component({
  selector: 'app-button',
  standalone: true,
  template: `
    <button [type]="type" [disabled]="disabled || loading" [class]="classes">
      <span *ngIf="loading" class="loading-spinner"></span>
      <span *ngIf="icon && !loading" class="btn-icon-symbol material-symbols-outlined">{{ icon }}</span>
      <ng-content></ng-content>
    </button>
  `
})
export class AppButtonComponent {
  @Input() variant: 'primary' | 'ghost' | 'outline' | 'danger' | 'default' = 'default';
  @Input() size: 'sm' | 'md' | 'icon' = 'md';
  @Input() icon?: string;
  @Input() loading = false;
  @Input() disabled = false;
  @Input() type: 'button' | 'submit' = 'button';

  get classes(): string {
    return [
      'btn',
      this.variant !== 'default' && `btn-${this.variant}`,
      this.size === 'sm' && 'btn-sm',
      this.size === 'icon' && 'btn-icon',
    ].filter(Boolean).join(' ');
  }
}
```

Quando todas as `<button class="btn ...">` estiverem migradas, o `_buttons.scss` pode mover-se pra dentro do componente.

### 2. `<app-input>` — médio ROI

`.input` e `.input-group` viram um componente com `[placeholder]`, `[icon]`, `[disabled]`, suporte a `ngModel`. Atalha o boilerplate de:

```html
<div class="input-group">
  <span class="input-icon material-symbols-outlined">search</span>
  <input class="input" type="text" [(ngModel)]="query" placeholder="Buscar...">
</div>
```

→

```html
<app-input icon="search" placeholder="Buscar..." [(ngModel)]="query"></app-input>
```

### 3. `<app-badge>` — baixo ROI mas trivial

3 linhas de template, 5 variantes. Faz sentido pra padronizar.

### 4. `<app-card>` — baixo ROI

`.card` é só um container com padding/borda. `<app-card>` com `[title]`, `[subtitle]` e `<ng-content>` simplifica um pouco. Considere se vale.

### 5. `<app-loading-spinner>` — trivial

Um único `<div class="loading-spinner">`. Componente simples com `[size]="'sm' | 'md' | 'lg'"`.

### Pular: `<app-pill>`, `<app-segment>`, `<app-config-menu-item>`

API ficaria mais verbosa do que a class atual; não vale.

## Convenções para futuros ajustes

1. **Toda nova feature**: estilo no `<componente>.scss`, não em partial global.
2. **Reusou em 2+ componentes**: extraia pra um partial em `src/styles/_xxx.scss` e adicione `@import` em `src/styles.scss`.
3. **CSS vars**: só pra tokens **theme-aware** (que mudam light/dark). Tudo mais vai pro `tailwind.config.js`.
4. **Dark mode**: prefira `dark:bg-X` Tailwind nativo quando possível (já habilitado via `darkMode: ['class', '[data-theme="dark"], body.theme-dark']`). Vars são fallback pra classes existentes.
5. **Antes de criar uma classe nova**: cheque se já existe no `_chips.scss`/`_buttons.scss`/etc.
