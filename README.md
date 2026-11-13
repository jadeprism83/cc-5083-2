# 平场补偿（固定拍摄装置）

从多张均匀参考图估计空间增益，再把受控的校正应用到同一装置采集的普通图片。
提供网页“图像恢复窗口”与命令行两条入口，二者共用同一套内核（`src/core/`）。

- 参考图自身的噪声、坏点、饱和区与局部遮挡会逐像素评估，不被直接当作增益；
- 接近零、低于暗电平或不可信的像素不会被无界放大，而是保留原值并标记；
- 暗电平、归一基准与最大补偿倍率可配置，并写入标定记录；
- 补偿是“空间乘法”，不改变目标图自身纹理，不做逐图对比度拉伸；
- 目标图尺寸、通道或采集设置与标定不一致时拒绝套用。

## 启动界面

需要 Node.js ≥ 18，无第三方依赖。

```bash
cd /workspace
npm start                 # 等价于 node src/server.js
# 平场补偿界面: http://localhost:8787/
```

浏览器打开 **http://localhost:8787/** 即为“图像恢复窗口”。端口可用
`PORT=9000 npm start` 修改。首次打开会自动载入 `data/demo` 的演示参考组。

界面工作流：

1. **参考组**：直接勾选演示数据（6 张带已知渐晕、尘埃遮挡、矩形遮光板、
   饱和区与热像素的合成参考），或在“上传文件”里选择自己的 PNG；左侧
   `采集设置 JSON` 必须填写必填字段（device、lens、aperture、focalLengthMm、
   zoom、binning）。
2. **暗电平与归一基准 / 增益与可信度**：控件由 `GET /api/options` 的字段
   描述动态生成，与内核 `validateOptions` 同源；修改最大倍率、可信阈值等会
   直接重新应用并刷新结果。
3. **估计增益**：调用 `/api/calibrate`，内核估计增益场并落盘到
   `calibrations/<id>/`（record.json + 二进制增益/置信度/标志位/噪声）。
4. **目标图**：选择演示目标或上传目标，右侧结果区显示
   `校正前 / 补偿后`、`补偿图像`、`可信区域`、`增益场` 四种视图；下方给出
   同一坐标区域的均值与噪声变化、逐行数值剖面与可信比例。
5. **拒绝**：把“目标采集设置”切到“变焦不一致”，内核返回 409，结果区显示
   拒绝原因（例如“变焦位置”不一致），不会生成补偿结果。
6. **批量导出**：勾选目标后点击“批量导出”，写出补偿 PNG、区域 CSV 与
   报告 JSON 到 `exports/`；尺寸不符的目标会单独标注失败原因。

“合成验证”按钮运行已知真值的完整链路：报告增益平均相对误差、均匀度
CV、各区域亮度恢复与噪声放大倍数，并给出相同区域校正前后的数值剖面。

## 命令行

内核也可脱离界面复现：

```bash
# 1) 估计增益
node src/cli.js calibrate \
  --settings @data/demo/references/settings.json \
  --ref data/demo/references/ref_1.png \
  --ref data/demo/references/ref_2.png \
  --ref data/demo/references/ref_3.png \
  --ref data/demo/references/ref_4.png \
  --ref data/demo/references/ref_5.png \
  --ref data/demo/references/ref_6.png \
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
```

常用标定选项：`--dark-mode manual|none|darkFrames`、`--dark-dn`、
`--norm-mode mean|median|percentile|fixed`、`--norm-percentile`、
`--max-gain`、`--min-gain`、`--smooth-px`、`--confidence`、
`--require-radiometry`。`--json` 让验证只输出汇总 JSON（剖面表平时走 stderr，
stdout 始终是机器可读 JSON）。

## 内核链路

```
参考组 + 采集设置
  → consistentGroup            尺寸/位深/通道/必填设置一致性校验
  → 暗电平                    手动定值 / 暗场组 / 不扣除（记录来源）
  → combineFrames              逐像素多帧中值 + MAD 离群剔除（坏帧/热像素）
  → findBadPixels              8 邻域中值，避免把真实边缘判成坏点
  → maskedGaussianBlur         带权平滑，σ = 平滑半径/3
  → 归一化基准                 可靠区分位数（默认 P95）或均值/中位数/固定 DN
  → 原始增益 + 置信度           基准/平滑信号；support×SNR×帧数驱动可信度
  → record.json                记录全部选项、来源与统计
```

应用阶段（`src/core/apply.js`）：

- 校验尺寸、通道、必填采集设置（ISO/曝光仅在 `requireRadiometryMatch` 时强制）；
- 低于或等于暗电平的像素原样输出，不做放大；
- 增益按本次的 `maxGain`/`minGain` 限幅并标记（估计阶段保存未限幅原始值，
  因此预览里改限幅无需重新标定）；
- 置信度不足的像素用 `smoothstep` 衰减增益，可信区之外不做强校正；
- 返回逐像素标志位、可信掩膜、实际套用倍率与统计。

标志位：`SATURATED`、`BAD_PIXEL`、`LOW_SIGNAL`、`DEAD`、`NO_VALID_VIEW`
（标定）；`TARGET_CLIPPED`、`TARGET_UNDER_DARK`、`GAIN_CAPPED`、
`GAIN_FLOORED`、`LOW_CONFIDENCE`、`CONTROL_INVALID`、`TAPERED`（应用）。

## 验证与测试

```bash
npm test        # node --test tests/kernel.test.js，21 项内核测试
npm run demo    # 重新生成 data/demo
```

合成场景包含已知径向渐晕（强度 0.42）、尘埃圆盘、矩形遮光板、
部分帧才出现的热像素与饱和区。当前默认配置的结果：

- 增益平均相对误差约 0.7%（剔除饱和/遮挡的可靠区后）；
- 均匀参考的 CV 由 0.236 降至 0.040；
- 角落与遮光板亮度显著恢复，噪声放大与所施加倍率一致且有上限；
- 校正后目标纹理的高通细节随倍率放大，未被平滑掉。

## 目录

```
src/core/     内核：png、stats、options、calibration、apply、store、validation、synthetic
src/server.js 网页后端（无依赖 HTTP）
src/web/      界面（index.html / styles.css / app.js）
src/cli.js    命令行入口
data/demo/    演示参考组与目标（含故意不匹配的设置）
tests/        内核测试
tools/        演示数据生成
```
