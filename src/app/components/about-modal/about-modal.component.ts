import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-about-modal',
  templateUrl: './about-modal.component.html',
  styleUrls: ['./about-modal.component.scss']
})
export class AboutModalComponent {
  @Input() isOpen = false;
  @Input() version = '';
  @Input() whatsNew: string[] = [];

  @Output() close = new EventEmitter<void>();
}
