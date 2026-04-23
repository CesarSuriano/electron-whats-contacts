import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AppShellSidebarComponent } from './app-shell-sidebar.component';

describe('AppShellSidebarComponent', () => {
  let fixture: ComponentFixture<AppShellSidebarComponent>;
  let component: AppShellSidebarComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [AppShellSidebarComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(AppShellSidebarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('renders the restored Agent and Settings navigation entries', () => {
    const sidebarText = fixture.nativeElement.textContent as string;

    expect(sidebarText).toContain('Agente');
    expect(sidebarText).toContain('Configurações');
  });

  it('emits the selected section when Configurações is clicked', () => {
    const emittedSections: string[] = [];
    component.sectionSelect.subscribe(section => emittedSections.push(section));

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.app-shell-sidebar__item')) as HTMLButtonElement[];
    const settingsButton = buttons.find(button => button.textContent?.includes('Configurações'));

    settingsButton?.click();

    expect(settingsButton).toBeTruthy();
    expect(emittedSections).toEqual(['settings']);
  });
});
