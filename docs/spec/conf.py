from docutils import nodes


def _force_longtable(app, doctree, docname):
    # Sphinx 仅对超过 30 行的表格使用 longtable。本规范的场景表行数少但单元格高，
    # 以 tabular 排版时无法跨页，会在页尾溢出并覆盖后续标题。
    if app.builder.format != "latex":
        return
    for table in doctree.findall(nodes.table):
        classes = table.setdefault("classes", [])
        if "longtable" not in classes:
            classes.append("longtable")


def setup(app):
    app.connect("doctree-resolved", _force_longtable)


project = "Mica 器件仿真规范"
language = "zh_CN"
root_doc = "index"
exclude_patterns = ["_build"]
nitpicky = True

latex_engine = "xelatex"
latex_documents = [("index", "mica-spec.tex", project, "", "manual")]
latex_elements = {
    "papersize": "a4paper",
    "pointsize": "11pt",
    "extraclassoptions": "oneside,openany",
    "fncychap": "",
    "fontpkg": r"\usepackage{lmodern}",
    "preamble": r"""
\usepackage[UTF8,scheme=chinese,fontset=fandol,heading=true]{ctex}
\ctexset{chapter={name={第,章},number=\arabic{chapter}}}
\setlength{\headheight}{14pt}
% 中文正文首行缩进两个汉字。Sphinx 默认引入 parskip 宏包，
% 以零缩进加段间距排版，这里改为缩进排法并相应收窄段间距。
\setlength{\parindent}{2\ccwd}
\setlength{\parskip}{0.25\baselineskip plus 1pt minus 1pt}
% 表格、列表和代码块内部保持齐头排版。
\AddToHook{env/longtable/begin}{\setlength{\parindent}{0pt}}
\AddToHook{env/tabular/begin}{\setlength{\parindent}{0pt}}
\AddToHook{env/tabulary/begin}{\setlength{\parindent}{0pt}}
\AddToHook{cmd/list/after}{\setlength{\parindent}{0pt}}
""",
}
