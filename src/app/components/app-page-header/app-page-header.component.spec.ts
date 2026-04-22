import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AppPageHeaderComponent } from './app-page-header.component';

@Component({
  template: `
    <app-page-header title="WhatsApp" subtitle="Conversas">
      <button header-actions type="button" class="header-inline-action">Agente</button>
      <button type="button" class="config-menu-item">Configuração</button>
    </app-page-header>
  `
})
class HostComponent {}

describe('AppPageHeaderComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [AppPageHeaderComponent, HostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders header actions outside the overflow menu', () => {
    const inlineAction = fixture.nativeElement.querySelector('.app-page-header__inline-actions .header-inline-action');

    expect(inlineAction).toBeTruthy();
    expect(inlineAction.textContent).toContain('Agente');
  });

  it('keeps regular projected content inside the config menu', () => {
    const menuButton = fixture.nativeElement.querySelectorAll('.app-page-header__menu-button')[1] as HTMLButtonElement;
    menuButton.click();
    fixture.detectChanges();

    const menuItem = fixture.nativeElement.querySelector('.header-config-menu .config-menu-item');

    expect(menuItem).toBeTruthy();
    expect(menuItem.textContent).toContain('Configuração');
  });
});
