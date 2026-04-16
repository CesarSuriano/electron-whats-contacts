import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';

import { getInitials } from '../../helpers/phone-format.helper';

@Component({
  selector: 'app-contact-avatar',
  templateUrl: './contact-avatar.component.html',
  styleUrls: ['./contact-avatar.component.scss']
})
export class ContactAvatarComponent implements OnChanges {
  @Input() name: string | null = '';
  @Input() photoUrl: string | null | undefined = null;
  @Input() size: 'sm' | 'md' | 'lg' = 'md';

  imageBroken = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['photoUrl']) {
      this.imageBroken = false;
    }
  }

  get initials(): string {
    return getInitials(this.name || '');
  }

  get hasImage(): boolean {
    return Boolean(this.photoUrl) && !this.imageBroken;
  }

  onImageError(): void {
    this.imageBroken = true;
  }
}
