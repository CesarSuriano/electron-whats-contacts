import { Component, EventEmitter, HostBinding, HostListener, Input, Output } from '@angular/core';

import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-page-header',
  templateUrl: './app-page-header.component.html',
  styleUrls: ['./app-page-header.component.scss']
})
export class AppPageHeaderComponent {
  @HostBinding('attr.title') readonly hostTitle: null = null;

  @Input() title = '';
  @Input() subtitle = '';
  @Input() navIcon = '';
  @Input() navLabel = '';
  @Input() showMenu = true;
  @Output() navClick = new EventEmitter<void>();

  isMenuOpen = false;

  get isDarkTheme(): boolean {
    return this.themeService.isDark;
  }

  constructor(private readonly themeService: ThemeService) {}

  toggleMenu(): void {
    this.isMenuOpen = !this.isMenuOpen;
  }

  closeMenu(): void {
    this.isMenuOpen = false;
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isMenuOpen) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (!target) {
      this.closeMenu();
      return;
    }

    const path = (event.composedPath && event.composedPath()) || [];
    for (const node of path) {
      if (node instanceof HTMLElement && node.hasAttribute('data-header-menu-root')) {
        return;
      }
    }

    if (target.closest('[data-header-menu-root]')) {
      return;
    }

    this.closeMenu();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isMenuOpen) {
      this.closeMenu();
    }
  }
}
