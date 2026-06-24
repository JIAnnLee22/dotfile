-- LSP 服务器配置列表（由 Arch 包管理器手动安装）
local servers = {
  -- Lua (lua-language-server)
  lua_ls = {
    cmd = { "lua-language-server" },
    settings = {
      Lua = {
        runtime = { version = "LuaJIT" },
        diagnostics = { globals = { "vim" } },
        workspace = { library = vim.api.nvim_get_runtime_file("", true) },
        telemetry = { enable = false },
      },
    },
  },

  -- Python (pyright)
  pyright = {
    cmd = { "pyright-langserver", "--stdio" },
    settings = {
      python = {
        analysis = {
          autoSearchPaths = true,
          diagnosticMode = "workspace",
          useLibraryCodeForTypes = true,
        },
      },
    },
  },

  -- TypeScript/JavaScript (typescript-language-server)
  tsserver = {
    cmd = { "typescript-language-server", "--stdio" },
    root_dir = function(fname)
      return require("lspconfig").util.root_pattern("package.json", "tsconfig.json", "jsconfig.json")(fname)
    end,
    single_file_support = true,
  },

  -- Tailwind CSS (tailwindcss-language-server)
  tailwindcss = {
    cmd = { "tailwindcss-language-server", "--stdio" },
    root_dir = function(fname)
      return require("lspconfig").util.root_pattern("package.json", "tailwind.config.js", "tailwind.config.ts")(fname)
    end,
  },

  -- Markdown (marksman)
  marksman = {
    cmd = { "marksman", "server" },
  },

  -- YAML (yaml-language-server)
  yaml_language_server = {
    cmd = { "yaml-language-server", "--stdio" },
    settings = {
      yaml = {
        hover = true,
        completion = true,
        validate = true,
        schemas = {
          kubernetes = { "*.k8s.yaml", "*.k8s.yml" },
        },
      },
    },
  },

  -- Bash (bash-language-server)
  bashls = {
    cmd = { "bash-language-server", "start" },
    filetypes = { "sh", "bash", "zsh" },
  },

  -- C/C++ (clangd)
  clangd = {
    cmd = { "clangd" },
    filetypes = { "c", "cpp", "objc", "objcpp" },
  },

  -- Rust (rust-analyzer)
  rust_analyzer = {
    cmd = { "rust-analyzer" },
    root_dir = function(fname)
      return require("lspconfig").util.root_pattern("Cargo.toml", "rust-toolchain.toml", ".git")(fname)
    end,
  },

  -- Go (gopls)
  gopls = {
    cmd = { "gopls" },
    root_dir = function(fname)
      return require("lspconfig").util.root_pattern("go.mod", ".git")(fname)
    end,
    settings = {
      gopls = {
        analyses = { unusedparams = true },
        staticcheck = true,
      },
    },
  },

  -- JSON (内置，无需额外配置)
  jsonls = {
    cmd = { "json-language-server", "--stdio" },
  },

  -- HTML (内置)
  html = {
    cmd = { "html-language-server", "--stdio" },
  },

  -- CSS (css-language-server)
  cssls = {
    cmd = { "css-language-server", "--stdio" },
  },

  -- Java / Kotlin (JDTLS - Eclipse JDT Language Server)
  jdtls = {
    cmd = { "jdtls" },
    filetypes = { "java", "kotlin" },
    root_dir = function(fname)
      return require("lspconfig").util.root_pattern(
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "pom.xml",
        ".git"
      )(fname)
    end,
    settings = {
      java = {
        jdk = { release = 17 },
        home = os.getenv("JAVA_HOME") or "",
        android = { enabled = true },
        lombok = { enabled = true },
        sources = {
          organizeImports = { starThreshold = 99 },
        },
      },
      kotlin = {
        codingStandard = { maxLineLength = 120 },
      },
    },
    init_options = { bundles = {} },
  },
}

return servers