# 平场补偿（固定拍摄装置）

从多张均匀参考图估计空间增益，再把受控的校正应用到同一装置采集的普通图片。
**主入口是网页"图像恢复窗口"**；命令行仅用于辅助平场补偿流程（脚本化标定、
批量复核、实验复现）。两者共用同一套内核（`src/core/`）。

- 参考图自身的噪声、坏点、饱和区与局部遮挡会逐像素评估，不被直接当作增益；
- 接近零、低于暗电平或不可信的像素不会被无界放大，而是保留原值并标记；
- 暗电平、归一基准与最大补偿倍率可配置，并写入标定记录；
- 补偿是"空间乘法"，不改变目标图自身纹理，不做逐图对比度拉伸；
- 目标图尺寸、通道或采集设置与标定不一致时拒绝套用。

## 图形入口：图像恢复窗口

需要 Node.js ≥ 18，无第三方依赖。

```bash
cd /workspace
npm start                 # 等价于 node src/server.js
# 平场补偿界面: http://localhost:8787/
```

浏览器打开 **http://localhost:8787/** 即为"图像恢复窗口"（平场补偿的图形
入口）。端口可用 `PORT=9000 npm start` 修改。首次打开会自动载入
`data/demo` 的演示参考组。

界面工作流：

1. **参考组**：直接勾选演示数据（6 张带已知渐晕、尘埃遮挡、矩形遮光板、
   饱和区与热像素的合成参考），或在"上传文件"里选择自己的 PNG；左侧
   `采集设置 JSON` 必须填写必填字段（device、lens、aperture、focalLengthMm、
   zoom、binning）。
2. **增益模型**：选择增益表示——`网格插值 grid`（默认，8px 控制格 +
   双线性展开）、`稠密逐像素 field`（历史基线）、`受约束基函数 basis`
   （对数多项式）。网格单元边长、基函数阶次与残差阈值随选择联动启停。
   模型政策见下文"增益模型"一节。
3. **暗电平与归一基准 / 增益与可信度**：控件由 `GET /api/options` 的字段
   描述动态生成，与内核 `validateOptions` 同源；修改最大倍率、可信阈值等会
   直接重新应用并刷新结果。
4. **估计增益**：调用 `/api/calibrate`，内核估计增益场并落盘到
   `calibrations/<id>/`（record.json + 二进制增益/置信度/标志位/噪声 +
   紧凑模型文件）。状态栏显示当前模型、模型大小与退化/未拟合比例。
5. **目标图**：选择演示目标或上传目标，右侧结果区显示
   `校正前 / 补偿后`、`补偿图像`、`可信区域`、`增益场` 四种视图；下方给出
   同一坐标区域的均值与噪声变化、逐行数值剖面与可信比例。
   **补偿图像与可信区域的异常**（可信区过低、增益封顶、目标欠曝/截断、
   模型未拟合区、网格退化区）以异常条形式标在视图上方。
6. **拒绝**：把"目标采集设置"切到"变焦不一致"，内核返回 409，结果区显示
   拒绝原因（例如"变焦位置"不一致），不会生成补偿结果。
7. **批量导出**：勾选目标后点击"批量导出"，写出补偿 PNG、区域 CSV 与
   报告 JSON 到 `exports/`；尺寸不符的目标会单独标注失败原因。

"合成验证"按钮运行已知真值的完整链路：报告增益平均相对误差、均匀度
CV、**留出帧**（未参与估计的参考图）平坦度、**纹理保持比**、**低亮度区
增益稳定性**、标定/应用耗时，以及各区域亮度恢复与噪声放大倍数。

## 增益模型

三种可切换的增益表示（界面"增益模型"一节 / CLI `--gain-model`）：

| 模型 | 表示 | 紧凑参数 | 适用 |
| --- | --- | --- | --- |
| `grid`（默认） | 8px 控制格加权中位数节点 + 双线性展开 | 节点的 1.6%（512×384 实测 12.4 KB vs 786 KB） | 一般场景，含局部遮挡 |
| `field` | 稠密逐像素（历史基线） | 无（即稠密场本身） | 对照实验、旧标定兼容 |
| `basis` | 对数域多项式（岭正则 + IRLS），exp 保证正增益 | 约 120 B | 纯渐晕类全局缓变场 |

**稀疏无效区政策（grid）**：支撑窗内可靠观测不足的节点按最近有效节点
跳数填充，置信度 ×0.7/跳，像素标记 `GRID_DEGRADED`；8 跳内无有效邻点则
判死（增益=1、置信度=0、`DEAD`），应用阶段衰减到原值。

**基函数无法表达细小遮光的政策（basis）**：对数残差超过
`basisResidualSigma`（默认 4）倍稳健标准差的可靠观测标记 `MODEL_UNFIT`，
置信度降为 0.25，应用阶段校正随之衰减——报告遮光，而不是用表达不了它
的模型强行校正。

技术选择实验（含留出帧检验、纹理保持、低亮度稳定性、模型大小与应用
成本的全部实测数值）见 [docs/gain-model-comparison.md](docs/gain-model-comparison.md)。

## 命令行（辅助）

命令行仅辅助平场补偿；图形入口见上文"图像恢复窗口"。

```bash
# 1) 估计增益（--gain-model grid|field|basis，--grid-cell，--basis-degree）
node src/cli.js calibrate \
  --settings @data/demo/references/settings.json \
  --ref data/demo/references/ref_1.png \
  --ref data/demo/references/ref_2.png \
  --ref data/demo/references/ref_3.png \
  --ref data/demo/references/ref_4.png \
  --ref data/demo/references/ref_5.png \
  --ref data/demo/references/ref_6.png \
  --gain-model grid --grid-cell 8 \
  --out calibrations/cli-demo --label 命令行演示

# 2) 应用（尺寸/设置不匹配时退出码 3 并给出原因）
node src/cli.js apply \
  --calibration calibrations/cli-demo \
  --image data/demo/targets/target_01.png \
  --settings @data/demo/targets/settings.json \
  --max-gain 4 --out exports/target_01_cli.png --report exports/target_01_cli.json

# 3) 合成验证（写出 report.json、剖面 CSV 与恢复图）
node src/cli.js validate --out exports/validation

# 4) 查看标定记录
node src/cli.js inspect --calibration calibrations/cli-demo

# 5) 增益模型参数搜索（全部验收门控通过才更新 config/gain-model.selection.json）
npm run compare

# 6) 从保存的中间场重算某个标定的全部发布数值
npm run recompute -- --calibration calibrations/cli-demo --target data/demo/targets/target_01.png
```

常用标定选项：`--dark-mode manual|none|darkFrames`、`--dark-dn`、
`--norm-mode mean|median|percentile|fixed`、`--norm-percentile`、
`--max-gain`、`--min-gain`、`--smooth-px`、`--confidence`、
`--gain-model`、`--grid-cell`、`--basis-degree`、`--basis-residual-sigma`、
`--require-radiometry`。`--json` 让验证只输出汇总 JSON（剖面表平时走
stderr，stdout 始终是机器可读 JSON）。

## 内核链路

```
参考组 + 采集设置
  → consistentGroup            尺寸/位深/通道/必填设置一致性校验
  → 暗电平                    手动定值 / 暗场组 / 不扣除（记录来源）
  → combineFrames              逐像素多帧中值 + MAD 离群剔除（坏帧/热像素）
  → findBadPixels              8 邻域中值，避免把真实边缘判成坏点
  → maskedGaussianBlur         带权平滑，σ = 平滑半径/3
  → 归一化基准                 可靠区分位数（默认 P95）或均值/中位数/固定 DN
  → 增益模型                   grid 节点中位数+跳数填充 / basis 对数多项式 / field 稠密
  → 原始增益 + 置信度           模型增益；观测质量×模型置信度驱动可信度
  → record.json                记录全部选项、来源、模型统计与警告
```

应用阶段（`src/core/apply.js`）：

- 校验尺寸、通道、必填采集设置（ISO/曝光仅在 `requireRadiometryMatch` 时强制）；
- 低于或等于暗电平的像素原样输出，不做放大；
- 增益按本次的 `maxGain`/`minGain` 限幅并标记（估计阶段保存未限幅原始值，
  因此预览里改限幅无需重新标定）；
- 置信度不足的像素用 `smoothstep` 衰减增益，可信区之外不做强校正；
- 返回逐像素标志位、可信掩膜、实际套用倍率与统计。

标志位：`SATURATED`、`BAD_PIXEL`、`LOW_SIGNAL`、`MODEL_UNFIT`、
`GRID_DEGRADED`、`DEAD`、`NO_VALID_VIEW`、`FILLED`（标定）；
`TARGET_CLIPPED`、`TARGET_UNDER_DARK`、`GAIN_CAPPED`、`GAIN_FLOORED`、
`LOW_CONFIDENCE`、`CONTROL_INVALID`、`TAPERED`（应用）。

## 持久化与可重算性

标定目录 `calibrations/<id>/`：

```
record.json      清单：选项、采集设置、统计、增益模型摘要、警告（schemaVersion 4）
gain.bin         Float32 稠密增益场（应用路径始终用它）
confidence.bin   Float32 逐像素置信度
flags.bin        Uint8 逐像素标志位
noise.bin        Float32 逐像素噪声（DN）
model.bin        紧凑模型参数（grid：Float32 节点；basis：Float64 系数），可选
model.json       紧凑模型元数据（几何/阶次），可选
```

旧标定（schemaVersion 3，无模型文件）按 `field` 模型正常加载，无需迁移。
`npm run recompute` 从上述中间场重算可信比例、标志位比例、低亮度增益
分布、模型与稠密场一致性（< 1e-4）与应用耗时——发布数值不依赖
record.json 的汇总块。

## 验证与测试

```bash
npm test        # 32 项内核与增益模型测试
npm run demo    # 重新生成 data/demo
npm run compare # 增益模型参数搜索（约 1 分钟，写 exports/model-comparison/）
```

合成场景包含已知径向渐晕（强度 0.42）、尘埃圆盘、矩形遮光板、
部分帧才出现的热像素与饱和区。当前默认配置（grid@8px）的结果：

- 增益平均相对误差 0.94%（剔除饱和/遮挡的可靠区后）；
- 均匀参考的 CV 由 0.237 降至 0.054（留出帧，未参与估计）；
- 真实纹理高通保持比 1.05（理想为 1）；
- 低亮度区（真值增益≥2）平均误差 8.3%、封顶比例 0；
- 角落与遮光板亮度显著恢复，噪声放大与所施加倍率一致且有上限。

## 目录

```
src/core/     内核：png、stats、options、gainmodel、calibration、apply、store、validation、synthetic
src/server.js 网页后端（无依赖 HTTP）
src/web/      界面（index.html / styles.css / app.js）
src/cli.js    命令行入口（辅助）
data/demo/    演示参考组与目标（含故意不匹配的设置）
docs/         增益模型对比实验说明
config/       已确认的模型选择（仅门控全过时更新）
tests/        内核与增益模型测试
tools/        演示数据生成、模型对比、指标重算
```
