import { Component, EventEmitter, Input, Output } from '@angular/core';

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
  isDarkTheme = document.body.classList.contains('theme-dark');

  toggleMenu(): void {
    this.isMenuOpen = !this.isMenuOpen;
  }

  closeMenu(): void {
    this.isMenuOpen = false;
  }

  toggleTheme(): void {
    this.isDarkTheme = !this.isDarkTheme;
    document.body.classList.toggle('theme-dark', this.isDarkTheme);
  }
}
