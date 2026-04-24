import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { BulkActionBarComponent } from './bulk-action-bar.component';

describe('BulkActionBarComponent', () => {
  let component: BulkActionBarComponent;
  let fixture: ComponentFixture<BulkActionBarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [BulkActionBarComponent],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(BulkActionBarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates successfully', () => {
    expect(component).toBeTruthy();
  });

  it('selectedCount defaults to 0', () => {
    expect(component.selectedCount).toBe(0);
  });

  it('totalVisible defaults to 0', () => {
    expect(component.totalVisible).toBe(0);
  });

  it('allSelected defaults to false', () => {
    expect(component.allSelected).toBe(false);
  });

  it('disabled defaults to false', () => {
    expect(component.disabled).toBe(false);
  });

  it('emits selectAll event', () => {
    let emitted = false;
    component.selectAll.subscribe(() => (emitted = true));
    component.selectAll.emit();
    expect(emitted).toBe(true);
  });

  it('emits clearSelection event', () => {
    let emitted = false;
    component.clearSelection.subscribe(() => (emitted = true));
    component.clearSelection.emit();
    expect(emitted).toBe(true);
  });

  it('emits exitMode event', () => {
    let emitted = false;
    component.exitMode.subscribe(() => (emitted = true));
    component.exitMode.emit();
    expect(emitted).toBe(true);
  });

  it('emits openBulkSend event', () => {
    let emitted = false;
    component.openBulkSend.subscribe(() => (emitted = true));
    component.openBulkSend.emit();
    expect(emitted).toBe(true);
  });

  it('renders the select-all action as Selecionar tudo', () => {
    fixture.detectChanges();

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.btn-link')) as HTMLButtonElement[];
    const selectAllButton = buttons.find(button => button.textContent?.includes('Selecionar'));

    expect(selectAllButton?.textContent).toContain('Selecionar tudo');
  });

  it('accepts input overrides', () => {
    component.selectedCount = 3;
    component.totalVisible = 10;
    component.allSelected = true;
    component.disabled = true;
    expect(component.selectedCount).toBe(3);
    expect(component.totalVisible).toBe(10);
    expect(component.allSelected).toBe(true);
    expect(component.disabled).toBe(true);
  });
});
