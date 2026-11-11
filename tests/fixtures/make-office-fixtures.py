# Generates small real Office/PDF fixtures with independent libraries (not AIJAVAIS's own writer).
import sys, os, subprocess, shutil, tempfile
out = sys.argv[1]
import docx
from docx.shared import Pt
d = docx.Document()
d.add_heading('季度复盘报告', level=1)
d.add_paragraph('本季度完成 3 个里程碑，客户满意度 92%。')
d.add_heading('风险与措施', level=2)
p = d.add_paragraph('供应延迟 & <备货> 风险；'); p.add_run('需要两周缓冲。').bold = True
d.add_paragraph('第一项行动', style='List Bullet')
t = d.add_table(rows=2, cols=3)
for i, row in enumerate([['指标', '目标', '实际'], ['交付率', '95%', '97%']]):
    for j, v in enumerate(row): t.cell(i, j).text = v
d.add_paragraph('English line: Revenue grew 12.5% YoY.')
d.save(os.path.join(out, 'report.docx'))
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = '销售'
ws.append(['地区', '销量', '单价', '金额']); ws.append(['华东', 120, 3.5, '=B2*C2']); ws.append(['华南', 80, 4, '=B3*C3']); ws.append(['备注', True, None, '含 "引号" 与 <尖括号>'])
ws2 = wb.create_sheet('Summary'); ws2['A1'] = 'total'; ws2['B1'] = 740
wb.save(os.path.join(out, 'sales.xlsx'))
from pptx import Presentation
from pptx.util import Inches
pr = Presentation()
s1 = pr.slides.add_slide(pr.slide_layouts[0]); s1.shapes.title.text = '新品发布计划'; s1.placeholders[1].text = '2027 年第一季度'
s2 = pr.slides.add_slide(pr.slide_layouts[1]); s2.shapes.title.text = '时间表'
tf = s2.placeholders[1].text_frame; tf.text = '一月：样机'; tf.add_paragraph().text = '二月：小批量 & 测试'
s2.notes_slide.notes_text_frame.text = '演讲备注：强调风险'
pr.save(os.path.join(out, 'launch.pptx'))
# PDF via LibreOffice from the DOCX (two pages forced by a page break).
d2 = docx.Document(); d2.add_paragraph('PDF 第一页：项目目标。'); d2.add_page_break(); d2.add_paragraph('Page two: acceptance criteria.')
tmp = tempfile.mkdtemp(); src = os.path.join(tmp, 'brief.docx'); d2.save(src)
subprocess.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', tmp, src], check=True, capture_output=True, timeout=180)
shutil.copy(os.path.join(tmp, 'brief.pdf'), os.path.join(out, 'brief.pdf')); shutil.rmtree(tmp)
