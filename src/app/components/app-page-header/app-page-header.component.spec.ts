import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

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
  let headerComponent: AppPageHeaderComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [AppPageHeaderComponent, HostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
    headerComponent = fixture.debugElement.query(By.directive(AppPageHeaderComponent)).componentInstance;
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

  it('closes the config menu when clicking outside the header menu', () => {
    const menuButton = fixture.nativeElement.querySelectorAll('.app-page-header__menu-button')[1] as HTMLButtonElement;
    menuButton.click();
    fixture.detectChanges();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(headerComponent.isMenuOpen).toBeFalse();
    expect(fixture.nativeElement.querySelector('.header-config-menu')).toBeFalsy();
  });

  it('closes the config menu on Escape', () => {
    const menuButton = fixture.nativeElement.querySelectorAll('.app-page-header__menu-button')[1] as HTMLButtonElement;
    menuButton.click();
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(headerComponent.isMenuOpen).toBeFalse();
  });
});
