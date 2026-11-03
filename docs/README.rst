================================================
规范构建
================================================

规范源文件位于 ``spec/``，使用 Sphinx 构建 HTML，或通过 LaTeX 构建 PDF。以下命令均在仓库根目录运行。

环境准备
------------------------------------------------

Sphinx
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

安装 Python 3.11 或更新版本，再安装 Sphinx：

.. code-block:: powershell

   python -m pip install sphinx==9.2.0
   sphinx-build --version

确保 Python 的脚本目录已加入 ``PATH``。也可以在已有的 uv 环境中使用 ``uv tool install sphinx==9.2.0`` 安装同一命令。

LaTeX
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

PDF 构建需要 XeLaTeX 和 latexmk。推荐使用 `TeX Live <https://www.tug.org/texlive/>`_；安装完成后，确认以下命令可用：

.. code-block:: powershell

   xelatex --version
   latexmk -v

完整的 TeX Live 安装包含本文所用宏包。使用 `TinyTeX <https://yihui.org/tinytex/>`_ 等精简发行版时，通过其包管理器补充中文排版与字体依赖：

.. code-block:: powershell

   tlmgr update --self
   tlmgr install latexmk xetex ctex fandol lm cmap parskip titlesec tabulary varwidth framed capt-of needspace wrapfig fancyvrb footnotehyper hypcap float upquote pict2e ellipse

TeX Live 和 TinyTeX 的 Windows 发行版包含运行 latexmk 所需的 Perl。其他发行版需按其安装说明准备 Perl；Linux 和 macOS 还需要可用的 ``make``。

更新 ``PATH`` 后重新打开终端，使 ``sphinx-build``、``xelatex`` 和 ``latexmk`` 可以被找到。

字体
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

中文采用 Fandol，西文采用 Latin Modern，均由 TeX 发行版提供，按各自的开源许可证分发。构建使用这些字体，不依赖 Windows 系统字体。

字体选择与纸张、章标题格式统一配置在 `spec/conf.py <spec/conf.py>`_。

构建命令
------------------------------------------------

.. code-block:: powershell

   pnpm docs:html
   pnpm docs:pdf

这两个命令分别直接执行：

.. code-block:: powershell

   sphinx-build -M html docs\spec dist\docs -n -W --keep-going
   sphinx-build -M latexpdf docs\spec dist\docs -n -W --keep-going

``latexpdf`` 由 Sphinx 生成 LaTeX 文件，再调用 latexmk 和 XeLaTeX 完成排版、目录和交叉引用。

输出位置
------------------------------------------------

* HTML 入口：``dist/docs/html/index.html``。
* PDF 文件：``dist/docs/latex/mica-spec.pdf``。
* LaTeX 源码和辅助文件：``dist/docs/latex/``。

所有产物均位于已忽略的 ``dist/`` 下。构建启用严格的 Sphinx 校验，文档警告按错误处理。

类型合同检查
------------------------------------------------

`IR 声明 <spec/contracts/ir.d.ts>`_、`Builder 声明 <spec/contracts/builder.d.ts>`_ 与 `宿主和 SDK 声明 <spec/contracts/host.d.ts>`_ 是规范附件。安装仓库既有依赖后，检查 IR、Builder 与宿主 SDK 的正反类型样例及随机参考向量：

.. code-block:: powershell

   pnpm exec tsc -p docs\spec\contracts\tsconfig.json
   node docs\spec\contracts\random-vectors.mjs

类型配置启用严格检查、精确可选字段与索引越界提示，并直接映射现有 lifecycle 源码。类型样例不执行；随机脚本只运行规范参考计算。两项验证均不代替编译器、IR 校验器或仿真运行时的一致性执行测试。
