const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, convertInchesToTwip } = require('docx');
const fs = require('fs');

const doc = new Document({
  sections: [{
    properties: {
      page: {
        margin: {
          top: convertInchesToTwip(1),
          right: convertInchesToTwip(1),
          bottom: convertInchesToTwip(1),
          left: convertInchesToTwip(1),
        },
      },
    },
    children: [
      // 标题
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [
          new TextRun({
            text: "2026年人工智能发展报告",
            bold: true,
            size: 56,
            color: "1a1a2e",
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
        children: [
          new TextRun({
            text: "AI Development Report 2026",
            size: 32,
            color: "666666",
            italics: true,
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 800 },
        children: [
          new TextRun({
            text: "——从能力突破到规模化应用的关键之年",
            size: 24,
            color: "888888",
          }),
        ],
      }),

      // 摘要
      new Paragraph({
        spacing: { before: 400, after: 300 },
        children: [
          new TextRun({ text: "摘要", bold: true, size: 36, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: `2026年是人工智能从技术突破走向规模化应用的关键之年。本报告系统梳理了2026年AI领域的技术进展、应用落地、产业发展与监管动态，涵盖大模型、Agent智能体、具身智能、行业应用、硬件基础设施及全球AI治理等核心维度。报告表明，多模态融合、推理优化、Agent自主化已成为当前AI发展的三大主线，全球AI产业正进入以"应用驱动"和"效率革命"为核心的新阶段。`,
            size: 24,
          }),
        ],
      }),

      // 第一章
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "第一章 大模型技术演进", bold: true, size: 40, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "1.1 多模态融合成为标配", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "2026年，语言模型、图像模型与音频模型之间的边界已基本消融。以GPT-5、Claude 4/5、Gemini 3、DeepSeek V4、Llama 4为代表的主流模型已实现原生多模态处理——在统一架构下同时完成文本生成、图像创作、视频合成、音频处理与代码编写的任务。这种融合不是简单的拼接，而是从注意力机制层面就打通了不同模态的表示空间，使模型能够在任一模态间进行自由跳转与联合推理。",
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "1.2 推理能力显著提升", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "延续OpenAI o1开启的推理优化范式，2026年推理模型（Reasoning Models）已成为科研、法律分析、软件架构等复杂任务场景的默认选项。推理链（Chain-of-Thought）的内化与扩展，使得模型在数学证明、代码调试、多步规划等任务上的错误率显著下降。测试时计算（Test-time Compute）资源的动态分配技术，使模型能够根据任务难度自适应地分配思考预算，在效率和效果之间取得更优平衡。",
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "1.3 高效架构降低部署门槛", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "混合专家模型（MoE）与知识蒸馏技术的成熟，使得7-13B参数规模的模型能够匹配过去需要5-10倍参数量的模型性能。API调用成本在过去一年内下降了约10倍，模型的边际推理成本已接近摩尔定律所描述的效率曲线。这一趋势极大推动了AI能力在中小企业和个人开发者群体中的普及。",
            size: 24,
          }),
        ],
      }),

      // 第二章
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "第二章 AI Agent：从研究演示到生产部署", bold: true, size: 40, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "2.1 Agent时代正式开启", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: `2026年被业界普遍视为"AI Agent元年"。此前停留在Demo阶段的智能体已大规模进入企业生产环境。与传统AI助手不同，Agent具备完整的任务闭环能力：接收高层目标后，可自主规划路径、调用工具、操作数据库与浏览器、响应反馈并迭代方案，最终交付可检验的结果。`,
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "2.2 技术支撑体系成熟", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: `Agent从"玩具"走向"工厂"依赖四项核心能力的成熟：工具调用（Tool Use）的可靠性达到生产级标准，可准确调用API、读写数据库、操控浏览器；超长上下文窗口（100万+ tokens）使Agent能完整理解并记忆复杂项目背景；高级规划与推理框架（如ReAct、Plan-and-Execute）为多步任务提供了稳定的执行骨架；多Agent编排系统（Multi-Agent Orchestration）支持多个专业Agent协同完成复杂工作流。`,
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "2.3 协议标准化加速生态互联", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: `Anthropic推出的模型上下文协议（Model Context Protocol, MCP）与Google推出的Agent-to-Agent协议（A2A）已成为行业事实标准。业界将其比作"智能体时代的HTTP协议"——如同早期互联网通过HTTP实现网页互联，这两个协议旨在实现不同Agent之间的互操作与生态开放。国内企业Agent市场已突破480亿元，40%的大型企业已在业务系统中嵌入任务型Agent。`,
            size: 24,
          }),
        ],
      }),

      // 第三章
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "第三章 行业应用纵深落地", bold: true, size: 40, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "3.1 医疗健康", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "FDA批准了首个AI全程主导的新药研发管线，标志着AI在药物发现领域从辅助工具升级为核心驱动力。AI辅助医学影像诊断准确率已达到99%，覆盖影像科、病理科等多个科室。国内AI诊疗方案已接入超过3500家基层医疗机构，有效提升基层诊疗能力。基因编辑指导、个性化治疗方案设计等场景也在加速落地。",
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "3.2 制造业与具身智能", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "具身智能（Embodied AI）取得突破性进展：AI驱动的机械臂在零样本物体操控任务中成功率达92%。智能工厂的产线换线时间从72小时缩短至4小时，显著提升柔性制造能力。材料科学领域，AI设计的合金材料展现出超预期的物理性能——耐热性提升达210%，已进入实际产品验证阶段。",
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "3.3 教育", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "AI教育应用从内容分发升级为过程性学习支持。智能学习监测系统通过实时分析学习行为，将有效学习时间占比从58%提升至79%。个性化辅导与干预系统能够根据学生的认知状态动态调整教学策略，因材施教的规模化成为可能。",
            size: 24,
          }),
        ],
      }),

      // 第四章
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "第四章 硬件基础设施", bold: true, size: 40, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "4.1 算力持续跃升", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "下一代GPU带来3-5倍的训练性能提升，能效比改善同样显著。全球数据中心容量的扩张持续加速，液冷散热技术的采纳率从35%跃升至62%，反映出AI负载对基础设施密度和能效的更高要求。",
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "4.2 端侧AI加速普及", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "端侧AI能力大幅增强，主流移动及边缘设备已具备50+ TOPS的本地推理算力，使得隐私敏感型任务的离线处理、实时响应型应用的本地化部署成为现实。这为AI与物联网、可穿戴设备、边缘机器人的深度融合奠定了硬件基础。",
            size: 24,
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "4.3 国产芯片崛起", bold: true, size: 28 }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "国内AI芯片市场份额从35%提升至50%，在部分推理场景已实现对进口芯片的替代。国产芯片在能效比和生态适配上的持续改进，正在重塑AI算力供给格局。",
            size: 24,
          }),
        ],
      }),

      // 第五章
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "第五章 全球AI治理", bold: true, size: 40, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "2026年，全球AI监管从框架制定进入实质性执法阶段。欧盟《AI法案》已开始有真金白银的处罚案例；美国通过行政令要求联邦政府建立AI治理框架；中国要求AI产品进行备案登记和安全评估。国际层面，各主要经济体在AI安全领域的合作机制逐步建立，全球AI治理峰会等高层次对话机制常态化。监管的核心焦点集中在：生成式内容溯源、深度合成管控、个人数据处理、大模型安全评估以及AI系统在关键基础设施中的应用边界。",
            size: 24,
          }),
        ],
      }),

      // 第六章
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "第六章 市场与产业格局", bold: true, size: 40, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: "API commoditization（模型推理能力的商品化）持续深化，模型调用成本在过去一年内降低约10倍，基础模型能力本身已难以成为差异化竞争壁垒。垂直AI公司迎来创纪录融资，专注于教育、医疗、法律、金融等领域的深度行业模型和应用创新成为资本新宠。AI原生公司（AI-native Companies）开始涌现——以10-100倍小于传统公司的团队规模，通过深度集成Agent实现了更高的运营效率和产出密度。开源生态（以DeepSeek、Llama 4、Mistral为代表）在性能上正在逼近闭源模型，开放、可定制、可微调的模型底座成为越来越多企业的首选。",
            size: 24,
          }),
        ],
      }),

      // 总结
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "结语", bold: true, size: 40, color: "1a1a2e" }),
        ],
      }),
      new Paragraph({
        spacing: { after: 400 },
        indent: { firstLine: 400 },
        children: [
          new TextRun({
            text: `2026年的人工智能发展，本质上是从"能力竞赛"到"效率竞赛"的深刻转变。技术层面，多模态、推理优化、Agent自主化三大主线已清晰；产业层面，规模化应用、成本压缩、垂直深耕成为竞争焦点；治理层面，安全与合规从倡议走向执法。展望未来，AI将更深层次地融入经济社会运行的底层逻辑，其所带来的机遇与挑战都需要我们以更前瞻、更务实的态度去应对。`,
            size: 24,
          }),
        ],
      }),

      // 数据表格
      new Paragraph({
        spacing: { before: 600, after: 300 },
        children: [
          new TextRun({ text: "附表：2026年AI发展关键指标一览", bold: true, size: 32, color: "1a1a2e" }),
        ],
      }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: "领域", bold: true })] })],
                width: { size: 25, type: WidthType.PERCENTAGE },
                shading: { fill: "1a1a2e" },
              }),
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: "核心进展", bold: true })] })],
                width: { size: 45, type: WidthType.PERCENTAGE },
                shading: { fill: "1a1a2e" },
              }),
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: "关键数据", bold: true })] })],
                width: { size: 30, type: WidthType.PERCENTAGE },
                shading: { fill: "1a1a2e" },
              }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun("大模型")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("多模态融合、推理优化")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("API成本下降10倍")] })] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun("AI Agent")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("生产级部署、多Agent编排")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("企业Agent市场480亿元")] })] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun("医疗")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("AI辅助诊断99%准确率")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("覆盖3500+基层医院")] })] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun("具身智能")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("零样本操控成功率")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("92%")] })] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun("教育")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("有效学习时间提升")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("58% → 79%")] })] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun("硬件")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("GPU性能、液冷技术采纳")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("训练性能3-5倍提升")] })] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun("国产芯片")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("市场份额提升")] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun("35% → 50%")] })] }),
            ],
          }),
        ],
      }),

      // 报告信息
      new Paragraph({
        spacing: { before: 800 },
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: "报告日期：2026年9月",
            size: 20,
            color: "888888",
          }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: "本报告基于公开资料整理，仅供参考",
            size: 20,
            color: "888888",
          }),
        ],
      }),
    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  // 输出到脚本自己所在目录：早先写死成仓库绝对路径，生成物就一直堆在安装目录里。
  const out = require('path').join(__dirname, 'AI发展报告2026.docx');
  fs.writeFileSync(out, buffer);
  console.log('Word 报告已生成: ' + out);
}).catch(err => {
  console.error('生成失败:', err);
});
