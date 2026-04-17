import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-page-header',
  templateUrl: './app-page-header.component.html',
  styleUrls: ['./app-page-header.component.scss']
})
export class AppPageHeaderComponent {
  @Input() title = '';
  @Input() navIcon = '';
  @Input() navLabel = '';
  @Output() navClick = new EventEmitter<void>();

  isMenuOpen = false;

  toggleMenu(): void {
    this.isMenuOpen = !this.isMenuOpen;
  }

  closeMenu(): void {
    this.isMenuOpen = false;
  }
}
