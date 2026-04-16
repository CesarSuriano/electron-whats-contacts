import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';

import { AboutModalComponent } from './about-modal.component';

describe('AboutModalComponent', () => {
  let component: AboutModalComponent;
  let fixture: ComponentFixture<AboutModalComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [AboutModalComponent],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(AboutModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates successfully', () => {
    expect(component).toBeTruthy();
  });

  it('isOpen defaults to false', () => {
    expect(component.isOpen).toBe(false);
  });

  it('version defaults to empty string', () => {
    expect(component.version).toBe('');
  });

  it('whatsNew defaults to empty array', () => {
    expect(component.whatsNew).toEqual([]);
  });

  it('accepts isOpen input as true', () => {
    component.isOpen = true;
    fixture.detectChanges();
    expect(component.isOpen).toBe(true);
  });

  it('accepts version input', () => {
    component.version = '2.0';
    expect(component.version).toBe('2.0');
  });

  it('accepts whatsNew input array', () => {
    component.whatsNew = ['Feature A', 'Feature B'];
    expect(component.whatsNew.length).toBe(2);
  });

  it('emits close event when close output fires', () => {
    let emitted = false;
    component.close.subscribe(() => (emitted = true));
    component.close.emit();
    expect(emitted).toBe(true);
  });
});
