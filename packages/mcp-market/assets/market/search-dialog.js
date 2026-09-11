(() => {
  const dialog = document.querySelector("[data-search-dialog]");
  const openButton = document.querySelector("[data-search-open]");
  const closeButton = document.querySelector("[data-search-close]");
  const form = document.querySelector("[data-search-form]");
  const input = document.querySelector("#market-search-input");
  const status = document.querySelector("[data-search-status]");
  const results = document.querySelector("[data-search-results]");

  if (
    !dialog ||
    !openButton ||
    !closeButton ||
    !form ||
    !input ||
    !status ||
    !results
  )
    return;

  let request;
  let timer;

  const clearResults = () => {
    results.replaceChildren();
  };

  const renderResults = (items) => {
    clearResults();
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "search-empty";
      empty.textContent = "没有匹配的专家或连接器。";
      results.append(empty);
      return;
    }

    for (const item of items) {
      const link = document.createElement("a");
      link.className = "search-result";
      link.href = `/market/${encodeURIComponent(item.slug)}`;

      const title = document.createElement("strong");
      title.textContent = item.displayName;
      const summary = document.createElement("span");
      summary.textContent = item.summary;
      const kind = document.createElement("small");
      kind.textContent = item.isExpertTeam ? "专家" : "连接器";

      link.append(title, summary, kind);
      results.append(link);
    }
  };

  const search = async () => {
    const query = input.value.trim();
    if (!query) {
      request?.abort();
      clearResults();
      status.textContent = "输入关键词开始搜索";
      return;
    }

    request?.abort();
    request = new AbortController();
    status.textContent = "正在搜索…";
    try {
      const response = await fetch(
        `/api/search?q=${encodeURIComponent(query)}`,
        {
          headers: { Accept: "application/json" },
          signal: request.signal,
        },
      );
      if (!response.ok) throw new Error("search failed");
      const payload = await response.json();
      renderResults(payload.items);
      status.textContent = `找到 ${payload.items.length} 个结果`;
    } catch (error) {
      if (error.name === "AbortError") return;
      clearResults();
      status.textContent = "搜索暂时不可用，请稍后重试。";
    }
  };

  const open = () => {
    dialog.showModal();
    input.focus();
    if (input.value.trim()) search();
  };

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    search();
  });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 180);
  });
})();
