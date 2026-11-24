// minemuster.com: the contact form.
// It sends what was typed to the server's submit_contact_request with the publishable key, which
// is made to be in a web page (row level security and the function's own checks guard the
// server). The server checks everything again; the checks here only save a round trip and say
// what is wrong in plain words. Nothing is sent until the person presses Send.

const ENDPOINT = 'https://jtdidkczekkzompmjfng.supabase.co/rest/v1/rpc/submit_contact_request';
const KEY = 'sb_publishable_njFgKrjUfyvc89_4SROxxw_VjWsZjiE';
const TIMEOUT_MS = 20000;

// The same limits as the server, after the same trimming.
const LIMITS = { name: 120, company: 160, email: 254, phone: 40, message: 4000 };
const EMAIL = /^[^@\s]{1,64}@[^@\s.]+(\.[^@\s.]+)+$/;

// What the server's hints mean, and the box each one is about.
const HINTS = {
  name_missing: ['name', 'Type your name.'],
  name_too_long: ['name', 'Keep your name to 120 characters.'],
  company_too_long: ['company', 'Keep the company name to 160 characters.'],
  email_invalid: ['email', 'Type an email address we can write back to.'],
  phone_too_long: ['phone', 'Keep the phone number to 40 characters.'],
  message_missing: ['message', 'Type a message.'],
  message_too_long: ['message', 'Keep the message to 4,000 characters.'],
};
const TOO_MANY = 'Too many messages. Try again later.';
const NOT_READY = 'The form is not taking messages yet. Try again later.';
const NO_NETWORK = 'The message did not go through. Check the connection, then press Send again.';
const FAILED = 'The message did not go through. Try again in a few minutes.';

const clean = (value) => value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();

// A link from another page can start the message for the person: /contact?about=delete-account, from
// the Delete your account page, for someone who cannot sign in. Only these topics; nothing else from
// the address goes into the form.
const TOPICS = {
  'delete-account': 'Please delete my MineMuster account. The email above is the one I sign in with, and the company above is the one I work for.',
};

function startMessage(form) {
  let about = null;
  try {
    about = new URLSearchParams(window.location.search).get('about');
  } catch {
    about = null;
  }
  const text = about && Object.prototype.hasOwnProperty.call(TOPICS, about) ? TOPICS[about] : null;
  const message = form.elements.namedItem('message');
  if (text && message && !message.value) message.value = text;
}

function check(values) {
  const errors = {};
  if (!values.name) errors.name = 'Type your name.';
  else if (values.name.length > LIMITS.name) errors.name = HINTS.name_too_long[1];
  if (!values.company) errors.company = 'Type the company you work for.';
  else if (values.company.length > LIMITS.company) errors.company = HINTS.company_too_long[1];
  if (!values.email) errors.email = 'Type your email address.';
  else if (values.email.length > LIMITS.email || !EMAIL.test(values.email)) errors.email = 'Type an email address we can write back to, like name@company.com.';
  if (values.phone.length > LIMITS.phone) errors.phone = HINTS.phone_too_long[1];
  if (!values.message) errors.message = 'Type a message.';
  else if (values.message.length > LIMITS.message) errors.message = HINTS.message_too_long[1];
  return errors;
}

function setUp(form) {
  startMessage(form);
  const field = (name) => form.elements.namedItem(name);
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.form-status');
  const label = button.textContent;
  let sending = false;

  const showError = (name, text) => {
    const input = field(name);
    const note = form.querySelector(`#${input.id}-error`);
    if (text) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', note.id);
      note.textContent = text;
      note.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      note.textContent = '';
      note.hidden = true;
    }
  };
  const clearErrors = () => { for (const name of Object.keys(LIMITS)) showError(name, ''); };
  const say = (text, kind) => {
    status.textContent = text;
    status.dataset.kind = kind || '';
  };

  // A box that was marked wrong is cleared once it is changed.
  form.addEventListener('input', (e) => {
    const name = e.target.name;
    if (name in LIMITS && e.target.getAttribute('aria-invalid') === 'true') showError(name, '');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    const values = {
      name: clean(field('name').value),
      company: clean(field('company').value),
      email: clean(field('email').value),
      phone: clean(field('phone').value),
      // The message keeps its lines; only the ends are trimmed.
      message: field('message').value.replace(/\r\n?/g, '\n').trim(),
    };
    clearErrors();
    const errors = check(values);
    const wrong = Object.keys(errors);
    if (wrong.length) {
      for (const name of wrong) showError(name, errors[name]);
      say(wrong.length === 1 ? 'One box needs a change before the message can go.' : `${wrong.length} boxes need a change before the message can go.`, 'error');
      field(wrong[0]).focus();
      return;
    }

    sending = true;
    button.disabled = true;
    button.textContent = 'Sending';
    say('Sending the message.', '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          p_name: values.name,
          p_company: values.company,
          p_email: values.email,
          p_phone: values.phone,
          p_message: values.message,
          p_website: field('website').value,
        }),
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (res.ok) {
        sent(form, values.email);
        return;
      }
      let answer = {};
      try { answer = await res.json(); } catch { /* not JSON */ }
      const hint = HINTS[answer.hint];
      if (res.status === 429 || answer.hint === 'too_many' || answer.code === 'PT429') {
        say(TOO_MANY, 'error');
      } else if (hint) {
        showError(hint[0], hint[1]);
        say('One box needs a change before the message can go.', 'error');
        field(hint[0]).focus();
      } else if (res.status === 404 || answer.code === 'PGRST202') {
        say(NOT_READY, 'error');
      } else {
        say(FAILED, 'error');
      }
    } catch {
      say(NO_NETWORK, 'error');
    } finally {
      clearTimeout(timer);
      sending = false;
      if (form.isConnected) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  });

  button.disabled = false;
}

// Sent: the form gives way to a note that says so, which takes the focus.
function sent(form, email) {
  const done = document.createElement('div');
  done.className = 'form-done';
  done.tabIndex = -1;
  done.setAttribute('role', 'status');
  const title = document.createElement('p');
  title.className = 'form-done-title';
  title.textContent = 'Message sent';
  const text = document.createElement('p');
  text.textContent = `Thank you. Your message reached us, with ${email} as the address to write back to.`;
  done.append(title, text);
  form.replaceWith(done);
  done.focus();
}

for (const form of document.querySelectorAll('form[data-contact]')) setUp(form);
