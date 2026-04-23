import { Component, EventEmitter, Input, Output } from '@angular/core';

import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-page-header',
  templateUrl: './app-page-header.component.html',
  styleUrls: ['./app-page-header.component.scss']
})
export class AppPageHeaderComponent {
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
}
