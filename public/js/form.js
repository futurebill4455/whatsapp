(function () {
  const form = document.getElementById('insuranceForm');
  if (!form) return;

  const steps = Array.from(form.querySelectorAll('.step'));
  const dots = Array.from(document.querySelectorAll('#progressDots .progress-dot'));
  const btnBack = document.getElementById('btnBack');
  const btnNext = document.getElementById('btnNext');
  const btnSubmit = document.getElementById('btnSubmit');
  const formError = document.getElementById('formError');
  const companySelect = document.getElementById('company');
  const membersStack = document.getElementById('membersStack');
  const membersJson = document.getElementById('members_json');
  const customerName = document.getElementById('customer_name');
  const memberCountInput = document.getElementById('member_count');
  const customWrap = document.getElementById('customMemberWrap');
  const customCount = document.getElementById('custom_member_count');
  const premiumAmount = document.getElementById('premium_amount');
  const policyDuration = document.getElementById('policy_duration');

  let current = 0;
  const total = steps.length;

  function showError(msg) {
    if (!formError) return;
    if (!msg) {
      formError.classList.add('hidden');
      formError.textContent = '';
      return;
    }
    formError.textContent = msg;
    formError.classList.remove('hidden');
  }

  function selectedTypeId() {
    const checked = form.querySelector('input[name="insurance_type"]:checked');
    return checked ? String(checked.getAttribute('data-type-id') || '') : '';
  }

  function filterCompanies() {
    if (!companySelect) return;
    const typeId = selectedTypeId();
    let firstVisible = null;
    Array.from(companySelect.options).forEach((opt, idx) => {
      if (idx === 0) {
        opt.hidden = false;
        return;
      }
      const optType = String(opt.getAttribute('data-type-id') || '');
      const match = !typeId || !optType || optType === typeId;
      opt.hidden = !match;
      if (match && !firstVisible) firstVisible = opt;
    });
    const selected = companySelect.selectedOptions[0];
    if (selected && selected.hidden) {
      companySelect.value = firstVisible ? firstVisible.value : '';
    }
  }

  function resolveMemberCount() {
    const chip = form.querySelector('input[name="member_count_chip"]:checked');
    const raw = chip ? chip.value : '1';
    if (raw === '4+') {
      customWrap?.classList.remove('hidden');
      const n = Math.max(4, Math.min(12, Number(customCount?.value || 4)));
      if (customCount && !customCount.value) customCount.value = String(n);
      return n;
    }
    customWrap?.classList.add('hidden');
    return Math.max(1, Number(raw) || 1);
  }

  function readExistingMembers() {
    const cards = Array.from(membersStack.querySelectorAll('.member-card'));
    return cards.map((card, i) => ({
      name: card.querySelector(`[name="member_${i}_name"]`)?.value || '',
      dob: card.querySelector(`[name="member_${i}_dob"]`)?.value || '',
      gender: card.querySelector(`input[name="member_${i}_gender"]:checked`)?.value || 'Male',
    }));
  }

  function genderTabs(index, selected) {
    return ['Male', 'Female', 'Other']
      .map(
        (g) => `
      <label class="gender-tabs cursor-pointer flex-1">
        <input type="radio" class="sr-only" name="member_${index}_gender" value="${g}" ${
          selected === g ? 'checked' : ''
        } />
        <span class="flex items-center justify-center rounded-lg border border-ink/15 bg-white px-2 py-2 text-xs font-semibold transition">${g}</span>
      </label>`
      )
      .join('');
  }

  function renderMembers() {
    const count = resolveMemberCount();
    memberCountInput.value = String(count);
    const prev = readExistingMembers();
    membersStack.innerHTML = '';

    for (let i = 0; i < count; i++) {
      const prevRow = prev[i] || { name: '', dob: '', gender: 'Male' };
      const card = document.createElement('div');
      card.className = 'member-card space-y-3';
      card.innerHTML = `
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">Member ${i + 1}</h3>
          <span class="chip bg-violet/10 text-violet">${i === 0 ? 'Primary' : 'Covered'}</span>
        </div>
        <div>
          <label class="label" for="member_${i}_name">Full name</label>
          <input class="field" type="text" id="member_${i}_name" name="member_${i}_name" value="${escapeAttr(
            prevRow.name
          )}" placeholder="Full name" autocomplete="name" />
        </div>
        <div>
          <label class="label" for="member_${i}_dob">Date of birth</label>
          <input class="field" type="date" id="member_${i}_dob" name="member_${i}_dob" value="${escapeAttr(
            prevRow.dob
          )}" />
        </div>
        <div>
          <p class="label">Gender</p>
          <div class="flex gap-2">${genderTabs(i, prevRow.gender || 'Male')}</div>
        </div>`;
      membersStack.appendChild(card);
    }
  }

  function escapeAttr(v) {
    return String(v || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function collectMembers() {
    const count = Number(memberCountInput.value || resolveMemberCount());
    const members = [];
    for (let i = 0; i < count; i++) {
      members.push({
        name: form.querySelector(`[name="member_${i}_name"]`)?.value?.trim() || '',
        dob: form.querySelector(`[name="member_${i}_dob"]`)?.value || '',
        gender: form.querySelector(`input[name="member_${i}_gender"]:checked`)?.value || '',
      });
    }
    return members;
  }

  function syncHiddenPayload() {
    const members = collectMembers();
    membersJson.value = JSON.stringify(members);
    customerName.value = members[0]?.name || '';
    const premiumChip = form.querySelector('input[name="premium_chip"]:checked');
    if (premiumChip) premiumAmount.value = premiumChip.value;
    const durationChip = form.querySelector('input[name="duration_chip"]:checked');
    if (durationChip) policyDuration.value = durationChip.value;
    memberCountInput.value = String(resolveMemberCount());
  }

  function premiumLabel() {
    const chip = form.querySelector('input[name="premium_chip"]:checked');
    return chip?.getAttribute('data-label') || premiumAmount.value || '—';
  }

  function durationLabel() {
    const chip = form.querySelector('input[name="duration_chip"]:checked');
    return chip?.getAttribute('data-label') || policyDuration.value || '—';
  }

  function fillReview() {
    syncHiddenPayload();
    const set = (key, val) => {
      const el = form.querySelector(`[data-review="${key}"]`);
      if (el) el.textContent = val || '—';
    };
    set('advisor_name', form.advisor_name?.value?.trim());
    set(
      'insurance_type',
      form.querySelector('input[name="insurance_type"]:checked')?.value
    );
    set('company', companySelect?.value);
    set('premium_amount', premiumLabel());
    set('member_count', memberCountInput.value);
    set('policy_duration', durationLabel());

    const list = document.getElementById('reviewMembers');
    if (!list) return;
    const members = collectMembers();
    list.innerHTML = members
      .map(
        (m, i) =>
          `<li class="rounded-lg bg-white border border-ink/10 px-3 py-2">
            <span class="font-medium">Member ${i + 1}:</span>
            ${escapeAttr(m.name) || '—'} · ${escapeAttr(m.dob) || 'DOB?'} · ${escapeAttr(m.gender) || '—'}
          </li>`
      )
      .join('');
  }

  function validateStep(index) {
    showError('');
    if (index === 0) {
      if (!form.advisor_name?.value?.trim()) {
        showError('Please enter the advisor name.');
        return false;
      }
    }
    if (index === 1) {
      if (!form.querySelector('input[name="insurance_type"]:checked')) {
        showError('Please select an insurance type.');
        return false;
      }
    }
    if (index === 2) {
      filterCompanies();
      if (!companySelect?.value) {
        showError('Please select a company.');
        return false;
      }
    }
    if (index === 3) {
      const chip = form.querySelector('input[name="premium_chip"]:checked');
      if (!chip && !premiumAmount.value) {
        showError('Please choose a premium / sum insured.');
        return false;
      }
    }
    if (index === 4) {
      renderMembers();
      const members = collectMembers();
      if (!members.length) {
        showError('Add at least one member.');
        return false;
      }
      for (let i = 0; i < members.length; i++) {
        if (!members[i].name) {
          showError(`Enter a name for member ${i + 1}.`);
          return false;
        }
        if (!members[i].dob) {
          showError(`Enter date of birth for member ${i + 1}.`);
          return false;
        }
        if (!members[i].gender) {
          showError(`Select gender for member ${i + 1}.`);
          return false;
        }
      }
    }
    if (index === 5) {
      const chip = form.querySelector('input[name="duration_chip"]:checked');
      if (!chip && !policyDuration.value) {
        showError('Please choose a policy duration.');
        return false;
      }
    }
    return true;
  }

  function goTo(index) {
    current = Math.max(0, Math.min(total - 1, index));
    steps.forEach((s, i) => s.classList.toggle('is-active', i === current));
    dots.forEach((d, i) => {
      d.classList.toggle('is-current', i === current);
      d.classList.toggle('is-done', i < current);
    });

    const atStart = current === 0;
    const atEnd = current === total - 1;
    btnBack.classList.toggle('opacity-0', atStart);
    btnBack.classList.toggle('pointer-events-none', atStart);
    btnNext.classList.toggle('hidden', atEnd);
    btnSubmit.classList.toggle('hidden', !atEnd);

    if (current === 2) filterCompanies();
    if (current === 4) renderMembers();
    if (current === 6) fillReview();
    showError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  btnBack?.addEventListener('click', () => goTo(current - 1));
  btnNext?.addEventListener('click', () => {
    if (!validateStep(current)) return;
    if (current === 1) filterCompanies();
    goTo(current + 1);
  });

  form.querySelectorAll('input[name="insurance_type"]').forEach((el) => {
    el.addEventListener('change', () => {
      filterCompanies();
      if (companySelect) companySelect.value = '';
    });
  });

  form.querySelectorAll('input[name="premium_chip"]').forEach((el) => {
    el.addEventListener('change', () => {
      premiumAmount.value = el.value;
    });
  });

  form.querySelectorAll('input[name="duration_chip"]').forEach((el) => {
    el.addEventListener('change', () => {
      policyDuration.value = el.value;
    });
  });

  form.querySelectorAll('input[name="member_count_chip"]').forEach((el) => {
    el.addEventListener('change', renderMembers);
  });
  customCount?.addEventListener('change', renderMembers);
  customCount?.addEventListener('input', renderMembers);

  form.addEventListener('submit', (e) => {
    if (!validateStep(4) || !validateStep(5) || !validateStep(0) || !validateStep(1) || !validateStep(2) || !validateStep(3)) {
      e.preventDefault();
      return;
    }
    syncHiddenPayload();
    if (!collectMembers()[0]?.name) {
      e.preventDefault();
      showError('Primary member name is required.');
      goTo(4);
    }
  });

  // Init from any pre-checked chips
  const prePrem = form.querySelector('input[name="premium_chip"]:checked');
  if (prePrem) premiumAmount.value = prePrem.value;
  const preDur = form.querySelector('input[name="duration_chip"]:checked');
  if (preDur) policyDuration.value = preDur.value;
  filterCompanies();
  renderMembers();
  goTo(0);
})();
