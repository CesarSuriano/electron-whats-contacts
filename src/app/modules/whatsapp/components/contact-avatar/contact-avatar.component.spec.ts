import { NO_ERRORS_SCHEMA, SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ContactAvatarComponent } from './contact-avatar.component';

describe('ContactAvatarComponent', () => {
  let fixture: ComponentFixture<ContactAvatarComponent>;
  let component: ContactAvatarComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ContactAvatarComponent],
      schemas: [NO_ERRORS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(ContactAvatarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  describe('initials getter', () => {
    it('returns initials from name', () => {
      component.name = 'Ana Silva';
      expect(component.initials).toBe('AS');
    });

    it('returns empty string for empty name', () => {
      component.name = '';
      expect(component.initials).toBe('?');
    });

    it('handles null name', () => {
      component.name = null;
      expect(component.initials).toBe('?');
    });

    it('handles single word name', () => {
      component.name = 'Carlos';
      expect(component.initials).toBe('CA');
    });
  });

  describe('hasImage getter', () => {
    it('returns false when photoUrl is null', () => {
      component.photoUrl = null;
      expect(component.hasImage).toBeFalse();
    });

    it('returns false when imageBroken is true', () => {
      component.photoUrl = 'https://example.com/photo.jpg';
      component.imageBroken = true;
      expect(component.hasImage).toBeFalse();
    });

    it('returns true when photoUrl is set and not broken', () => {
      component.photoUrl = 'https://example.com/photo.jpg';
      component.imageBroken = false;
      expect(component.hasImage).toBeTrue();
    });
  });

  describe('onImageError', () => {
    it('sets imageBroken to true', () => {
      component.imageBroken = false;
      component.onImageError();
      expect(component.imageBroken).toBeTrue();
    });
  });

  describe('ngOnChanges', () => {
    it('resets imageBroken when photoUrl changes', () => {
      component.imageBroken = true;
      component.ngOnChanges({
        photoUrl: new SimpleChange('old.jpg', 'new.jpg', false)
      });
      expect(component.imageBroken).toBeFalse();
    });

    it('does NOT reset imageBroken when other input changes', () => {
      component.imageBroken = true;
      component.ngOnChanges({
        name: new SimpleChange('old', 'new', false)
      });
      expect(component.imageBroken).toBeTrue();
    });
  });
});
