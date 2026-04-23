import { Component, EventEmitter, Input, Output } from '@angular/core';

import { AppShellSection } from '../../models/shell.model';
import { ThemeService } from '../../services/theme.service';

interface SidebarItem {
  id: AppShellSection;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-shell-sidebar',
  templateUrl: './app-shell-sidebar.component.html',
  styleUrls: ['./app-shell-sidebar.component.scss']
})
export class AppShellSidebarComponent {
  @Input() activeSection: AppShellSection = 'home';
  @Input() whatsappBadge = 0;
  @Input() schedulesBadge = 0;
  @Input()
  set expanded(value: boolean) {
    this.isExpanded = value;
  }

  get expanded(): boolean {
    return this.isExpanded;
  }

  @Output() sectionSelect = new EventEmitter<AppShellSection>();
  @Output() about = new EventEmitter<void>();
  @Output() expandedChange = new EventEmitter<boolean>();

  isExpanded = true;

  get isDarkTheme(): boolean {
    return this.themeService.isDark;
  }

  readonly primaryItems: SidebarItem[] = [
    { id: 'home', label: 'Inicio', icon: 'home' },
    { id: 'whatsapp', label: 'WhatsApp', icon: 'chat_bubble' },
    { id: 'clients', label: 'Clientes', icon: 'group' }
  ];

  readonly toolItems: SidebarItem[] = [
    { id: 'messages', label: 'Mensagens', icon: 'chat' },
    { id: 'schedules', label: 'Agendamentos', icon: 'calendar_today' }
  ];

  readonly systemItems: SidebarItem[] = [
    { id: 'settings', label: 'Configurações', icon: 'settings' }
  ];

  constructor(private readonly themeService: ThemeService) {}

  select(section: AppShellSection): void {
    this.sectionSelect.emit(section);
  }

  toggleExpanded(): void {
    this.isExpanded = !this.isExpanded;
    this.expandedChange.emit(this.isExpanded);
  }

  get sidebarToggleLabel(): string {
    return this.isExpanded ? 'Fechar menu lateral' : 'Abrir menu lateral';
  }

  trackBySectionId(_index: number, item: SidebarItem): string {
    return item.id;
  }

  badgeFor(section: AppShellSection): number {
    if (section === 'whatsapp') {
      return this.whatsappBadge;
    }

    if (section === 'schedules') {
      return this.schedulesBadge;
    }

    return 0;
  }
}
