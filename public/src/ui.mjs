export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'onClick') node.addEventListener('click', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function replace(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
}

export function button(text, callback, className = 'quiet') {
  return el('button', { type: 'button', className, onClick: callback }, text);
}

export function fieldError(text) {
  return el('p', { className: 'field-error', role: 'alert' }, text);
}
