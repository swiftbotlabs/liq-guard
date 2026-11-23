// HTML preview renderer: draws the exact container specs the glasses get, at 576 x 288, 1 CSS px = 1 display px.
// Approximation: the firmware font is a proportional LVGL sans (~19 px); brightness levels map to five greens.
import type { Page } from '../shared/screens';
import type { Renderer } from './controller';

export const GREENS = ['#0b3314', '#176b2a', '#25a03f', '#33cf55', '#45ff6a'];
const BORDER = (c: number) => `rgb(${Math.round((c / 15) * 69)}, ${Math.round((c / 15) * 255)}, ${Math.round((c / 15) * 106)})`;

export class DomRenderer implements Renderer {
  pages = 0;
  upgrades = 0;
  private key = '';
  constructor(private root: HTMLElement) {
    root.style.cssText = 'position:relative;width:576px;height:288px;background:#000;overflow:hidden;font-family:Inter,"Helvetica Neue",Arial,sans-serif;font-size:19px;line-height:26px;';
  }
  async show(p: Page) {
    if (p.key === this.key) this.upgrades++; else this.pages++;
    this.key = p.key;
    this.root.replaceChildren(...p.boxes.map((b) => {
      const el = document.createElement('div');
      el.dataset.name = b.name;
      const pad = b.padding ?? 0;
      el.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;box-sizing:border-box;` +
        `padding:${pad}px;white-space:pre-wrap;overflow:hidden;color:${GREENS[b.color ?? 4]};` +
        (b.border ? `border:${b.border}px solid ${BORDER(b.borderColor ?? 15)};border-radius:4px;` : '');
      el.textContent = b.content;
      return el;
    }));
  }
}
