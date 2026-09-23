---
"title": "翻译Extreme Spontaneous Deformations of Active Crystals"
"slug": "translate/翻译Extreme Spontaneous Deformations of Active Crystals"
"pubDate": "2024-02-05T14:41:00+08:00"
"updatedDate": "2026-07-21T11:12:00+08:00"
"categories":
  - "物理"
"tags":
  - "翻译"
---

> 以下内容是对文献 [Phys. Rev. Lett. 131, 108301 (2023) - Extreme Spontaneous Deformations of Active Crystals (aps.org)](https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.131.108301) 的机翻 + 简单修改。
>
> 翻译可能存在一些不足之处，还望见谅。

## 摘要

我们展示了由活性粒子构成的二维晶体可以*在不熔化的情况下*经历极其大的自发变形。通过使用主要通过成对斥力相互作用的粒子，我们发现这种活性晶体保持长程 (long-range) 键序 (bond order) 和代数衰减的 (algebraically decaying) 位置序 (positional order)，但指数 $\eta$ 不受 (平衡) KTHNY 理论给出的 $1/3$ 的上界。我们使用线性弹性理论 (linear elastic theory) 解释了我们的发现，并展示了量化大尺度变形和键序波动 (bond-order fluctuations) 的两个明确定义的有效温度的存在。这些现象的根源在于粒子固有轴的唯一时间持久性，因此应该在许多不同的情况下观察到它们。

## 正文

二维晶相通常由位置序的缓慢代数衰变和长程键序的存在来定义。在热平衡中，位置相关函数 (positional correlation function) 的衰变指数 $\eta$ 随温度而增加。在许多情况下，著名的 Kosterlitz-Thouless Halperin-Nelson Young (KTHNY) 理论 [^1] [^2] [^3] [^4] [^5] 很好地描述了，二维晶体的熔化是一个**两步过程**，在晶体和液相之间产生具有短程位置序和准长程键序的中间相——通常是六角相 (hexatic phase) (参见，例如 [^6]，了解经典综述)。第一步被定义为当热激活的位错对可以解离时。这通常发生在孤立位错的熵和弹性能平衡时。KTHNY 理论告诉我们，当随着温度升高的 $\eta$ 达到 $1/4$ 到 $1/3$ 之间的值时，(对于六方晶体) 这一定会发生。这种结合可以被视为对二维晶体的可变形性施加了限制。

由活性粒子构成的晶体通过在局部时间尺度和长度尺度上持续注入机械功来维持非平衡状态，因此不受与其平衡对应物相同的约束。特别是基于这样的一般性原因，人们不应该期望 KTHNY 理论适用于二维活性晶体的熔化。因此，迄今为止，大多数对这类晶体 (不具有手性或定向序) 熔化的简化版本的研究都得出了 KTHNY 理论仍然适用的结论，或者假设它仍然适用于决定熔化何时以及如何发生。[^7] [^8] [^9] [^10] [^11] [^12] [^13] [^14] [^15] [^16] [^17] [^18]

在这篇文章中，我们展示了二维活性晶体可以在不熔化的情况下经历极端的自发变形：它们可以保持真正的长程键序，即使位置序相关性衰减得非常快，也可以抵抗位错对的解除结合，尽管仍然是代数衰减。我们认为衰变指数 $\eta$ 实际上可以任意大，并通过两个明确定义的有效温度来解释我们的发现，这两个温度分别量化了弹性变形和键序波动。

许多研究中的活性晶体由旋转单元或个体自组织的涡旋组成，在二维中形成六角格子 [^19] [^20] [^21] [^22] [^23] [^24] [^25] [^26] [^27] [^28] [^29]。这种手性活性晶体被研究其特定属性，如边缘模式和奇异弹性。[^30] [^31] [^32] [^33]

还考虑了具有粒子固有极性的强排列的活性晶体。模型证明了在相对较小的系统中传播晶体 [^34] [^35] [^36] [^37] [^38] [^39] [^40] [^41] [^42] [^43] [^44] 的可能性。Dauchot 等人的实验研究了极性排列粒子的小晶体 [^45],[^46]。在理论方面，Maitra 和 Ramaswamy 最近的工作 [^47] 对定向活性固体进行了一般预测，但迄今为止尚未进行测试。

在这里，我们研究了由自推进粒子制成的更简单的活性晶体的熔化，这些粒子受到成对排斥力和旋转噪声的作用，其极性没有或弱排列。先前的工作已经得出结论或假设 KTHNY 理论仍然相关。它们通常依赖于对位置序相关函数衰减的数值估计，这是一项困难的任务，因为通常只考虑了相对较小的系统尺寸，并且通常考虑的函数通常是固有振荡 (intrinsically oscillatory) 的。下面我们绕过这个问题，这样可以获得更清晰的结果。

我们首先考虑在具有周期性边界条件的二维域中，$N$ 个 **过阻尼** 的 **活性布朗粒子** (active Brownian particles, ABPs) 通过软谐波成对力和局部铁磁排列相互作用。它们的位置 $r_i$ 和极性 $\theta_i$ 服从：

$$
\dot{\mathbf{r}}_i = s_0 \mathbf{e}(\theta_i) + \mu_r \sum_{j \sim i} (d_0 - r_{i,j}) \mathbf{e}_{i,j} \tag{1}
$$

$$
\dot{\theta}_i = \kappa \sum_{j \sim i} \sin(\theta_j - \theta_i) + \sqrt{2D_r} \xi_i(t) \tag{2}
$$

其中 $\mathbf{e}(\theta_i)$ 表示 $\theta_i$ 方向的单位矢量，$r_{ij}=|r_i-r_j|$，$\mathbf{e}_{ij}$ 表示由 $j$ 指向 $i$ 的单位矢量，求和的范围是对所有与粒子 $i$ 距离在 $d_0$ 之内的粒子，$\xi_i(t)$ 是均值为零的高斯噪声 (Gaussian white noise)

$$
\left\langle \xi_i(t) \xi_j(t^{\prime}) \right\rangle = \delta_{ij} \delta(t-t^{\prime})
$$

数值细节由 [^48] 给出。

我们在不失一般性的情况下固定 $d_0=1, \mu_r=1.5$，主要在旋转噪声强度 (rotational noise strength) $D_r=1$ 条件下，改变剩余的两个参数，自推进速度 (self-propulsion speed) $s_0$ 和对齐强度 (alignment strength) $\kappa$。为了设置阶段，我们首先在这个 $(s_0, \kappa)$ 平面上显示我们的模型的相图。足够强的排列 $(\kappa \gtrsim 0.65)$ 产生全局极性序 ($\Psi=|\langle e^{i \theta_j} \rangle_j|>0$)。在这个过程中，我们专注于*排斥相互作用主导排列的*互补区域，其中 $\Psi \approx 0$，极性相关性以指数形式迅速衰减。这里主要感兴趣的晶相是在较小的 $s_0$ 或 $\kappa$ 值下发现的。在较大的 $s_0$ 或 $\kappa$ 值下发现了液相。根据 KTHNY 的两步方案，这两个相被一个六角序区域分开。

我们的主要兴趣是晶体排列的稳定性，我们考虑最初的完美六方构型，晶格步长 $\ell_0=\sqrt{3}/2$，产生平均数密度 $\rho \simeq 1.54$。下面，$L$ 是近似正方形域在 $y$ 中的线性大小。

晶体相中的位置序通过两点相关函数 [^49] 的大尺度行为进行估计

$$
\hat{g}(r) = \left\langle \frac{\sum_{j \ne k} \delta(r-|\hat{r}_j-\hat{r}_k|) e^{i G \cdot (u_j - u_k)}}{\sum_{j \ne k} \delta(r-|\hat{r}_j-\hat{r}_k|)} \right\rangle_{t} \tag{3}
$$

其中，$\hat{r}_i$ 是粒子 $i$ 在初始完美晶格上的位置，$u_i(t)=r_i(t)-\hat{r}_i$ 是其位移矢量，而 $\hat{G}$ 是完美晶格的倒格矢中的一个。

取向键序 (对于三角晶格的晶体来说是六角的) 的关联函数 $\hat{g}_6(r)$ 可以类似地定义，用 $\psi_6^{*}(j) \psi_6(k)$ 代替 $\hat{g}(r)$ 中的 e 指数部分，其中局部序 (local order) $\psi_6(j)=\left\langle e^{i 6 \theta_{j j^{\prime}}}\right\rangle_{j^{\prime} \sim j}$，$j^{\prime}$ 表示粒子 $j$ 的 Voronoi 邻居，$\theta_{j j^{\prime}}$ 是 $r_{j^{\prime}}−r_j$ 的方向。

关联函数 $\hat{g}(r), \hat{g}_6(r)$ 适用于最多有界位错对的构型。它们具有无固有振荡的巨大优势，因此它们的渐近行为可以很容易地测量。

正如预期的那样，在晶体区域中观察到准长程位置序，$\hat{g}(r) \sim r^{-\eta}$，如图 1b 所示，绘制了在增加系统尺寸时获得的结果 [^50]。值得注意的是，在这种情况下测得的 $\eta \simeq 0.68$ 值远大于 KTHNY 理论设定的上界 $1/3$，但存在真正的长程键序 (如图 1c 所示)，并且没有发现未结合的位错 (几乎没有发现任何结合的位错对)。在不同的对准强度 $\kappa$ 和自推进速度 $s_0$ 值下重复这些测量，我们发现 $\eta$ 随着 $\kappa$ 和 $s_0$ 的增加而增加 (图 1d 和 图 1e)。有趣的是，我们观察到 $\eta \propto s_0^2$ (在常数 $\kappa$ 下)。

我们现在提出了一般性的论点，主张在活性晶体中观察到 $\eta>1/3$ 的可能性。在热平衡中，线性弹性理论 [^4],[^51] 给出

$$
\eta = k_B T |\hat{G}|^2 \frac{3\mu + \lambda}{4\pi \mu (2\mu + \lambda)} \tag{4}
$$

其中 $\mu$ 和 $\lambda$ 都是拉梅弹性系数。熔化大致发生在熵和形成位错所需的弹性能量平衡时。这一由 KTHNY [^6] 精确描述的声明，给出了 *熔化温度*

$$
k_B T_m = \ell_0^2 \frac{\mu(\mu+\lambda)}{4\pi(2\mu+\lambda)} \tag{5}
$$

通过消除 $k_B T$ 将这两个方程结合起来，又因为对于三角形晶格有 $|\hat{G}|^2 \ell_0^2=(16/3)\pi^2$，可得熔化时的 $\eta$

$$
\eta = \frac{(\mu+\lambda)(3\mu+\lambda)}{3(2\mu+\lambda)^2}
$$

这个表达式有一个上界 $1/3$。[^52]

当然，在不平衡的情况下，情况可能会大不相同。我们在这里主张并稍后展示，可以在某种意义上仍然调用两个平衡关系 (4) 和 (5)，但在两个不同的噪声水平或有效温度下：参与 (4) 的 $T_S$ 表征晶体结构的大尺度弹性变形，参与 (5) 的 $T_D$ 推动位错运动。假设持久极性的弱极性排列平滑了局部不规则性，可以预期 $T_D<T_S$，当 (4) 和 (5) 结合时，在熔化时产生大于 $1/3$ 的 $\eta$ 值。

这些想法可以通过考虑极性场 $\mathbf{s}=s_0 \mathbf{e}(\theta)$ 来变得更加具体。我们观察到的 $\eta \propto s_0^2$ 表明，$\mathbf{s}$ 可以被视为有效的空间和时间相关噪声。我们已经计算了 $\mathbf{s}$ 的空间功率谱 (图 2a)。小波数下的平台定义了对应于 $T_S$ 的有效温度，而较低的噪声水平 $T_D$ 可归因于 $k>1$ (近晶格间距) 行为 [^53]。这些光谱可以通过将其除以 $s_0^2$ (未显示) 来叠加，而对应于 $T_S$ 的低 $k$ 平台值随着 $\kappa$ 的增加而增加 (图 2a 上的插图)。请注意，这与我们的观察结果一致，即 $\eta$ 随 $s_0^2$ (线性) 和 $\kappa$ 增加 (图 1d 和图 1e)。

我们的大多数发现都可以在线性弹性理论中解释。控制位移场 $\mathbf{u}$ 的方程可以表示为 [^44],[^54]

$$
\partial_t \mathbf{u} = (\lambda+\mu) \nabla (\nabla \cdot \mathbf{u}) + \mu \nabla^2 \mathbf{u} + \mathbf{s} \tag{6}
$$

在平衡时，$\mathbf{s}$ 是定义热温度 $k_B T$ 的白噪声，但在我们的活性晶体中，可以预期 [^55]

$$
\partial_t \mathbf{s} = -a \mathbf{s} + b \nabla^2 \mathbf{s} + \mathbf{\sigma} \tag{7}
$$

其中白噪声 $\mathbf{\sigma}$ 可以从粗粒化方程 (1) 和 (2) 中获得 $\left\langle \sigma_\alpha(\mathbf{r},t) \sigma_\beta(\mathbf{r}^{\prime},t^{\prime}) \right\rangle = s_0^2 D_r \rho \delta_{\alpha,\beta} \delta(\mathbf{r}-\mathbf{r}^{\prime}) \delta(t-t^{\prime})$。系数 $a$ 和 $b$ 是正的：$-a \mathbf{s}$ 是一个阻尼项，用于解释极性的短程相关性，拉普拉斯算子是由弱对齐相互作用产生的。

$\mathbf{u}$ 的空间光谱可以根据线性方程 (6) (7) 计算 [^48]。它在低波数极限（即长波极限）给出

$$
\lim_{k\to 0} \left\langle |\tilde{\mathbf{u}}(k)|^2 \right\rangle = \frac{\rho(\lambda+3\mu)}{\mu(\lambda+2\mu)} \frac{s_0^2 D_r}{2 a^2 k^2} \tag{8}
$$

与平衡情况相比，它给出有效温度 $T_S = \frac{1}{2} s_0^2 D_r / a^2$ [^56]。对于 $\left\langle |\tilde{\mathbf{u}}(k)|^2 \right\rangle$，线性理论与数值估计有很好的一致性：固定 $s_0$，改变 $\kappa$，通过 $k^{*}(\kappa)$ 和系数 $c^{*}(\kappa)$ 重新缩放波数产生了极好的坍塌，揭示了在低 $k$ 时 $1/k^2$ 的行为，在高 $k$ 时 $1/k^6$ 的衰减 (图 2b，计算过程在 [^48])。乘积 $c^{*}(\kappa) {k^{*}}^2(\kappa)$ 提供了方程 (8) 中 $1/k^2$ 因子的估计。因此，使用方程 (4)，衰变指数 $\eta$ 可以重新表示为 $\eta = (1/4\pi) |\hat{G}|^2 c^{*} {k^{*}}^2$。正如预期的那样，这些估计与通过直接计算 $\hat{g}(r)$ 的衰变而获得的估计非常匹配 (图 2c)。

值得注意的是，基于光谱的 $\eta$ 值甚至比直接的 $\eta$ 值延伸得更远，图 2c 所示的情况下达到 $\eta \simeq 20$。当 $\eta \to 2$ 时，直接评估 $\eta$ 会失效，因为此时具有幂律发散的布拉格峰的概念消失了 [^48]。然而，即使晶体的畸变超过晶格间距，变形场 $\mathbf{u}$ 的行为仍然平滑，局部保持了晶体序，而六角键序明显是长程的 (图 3a 和图 3b)。正如预期的那样，结构因子在傅里叶空间呈现出六重对称性 (证明了晶体序)，但它由光滑的、非发散的、有噪音的延伸峰组成 (见图 3c)。中心区域当 $|q| \to 0$ 时变平 ，且高 $q$ 区域中的其他峰值呈现出 $q^{-2}$ 的缩放。所有这些都与较小 $\kappa$ 值下的行为有质的不同，其中 $\eta<2$，并且观察到具有幂律散度 $|q_y-q^{*}|^{\eta-2}$ 的峰值 (图 3d)。因此，通过 $\left\langle |\tilde{\mathbf{u}}(k)|^2 \right\rangle$ 获得的 $\eta$ 的估计仍然是良好定义的。与直接测量相反，它们几乎可以延伸到接近晶体-六角晶相转变。

我们现在考虑我们的活性晶体的键序性质。在固定的参数值下，可以用来自诸如图 1c 中的数据估计渐近的非零值，即 $\hat{g}_6^{\infty}=\lim_{L, r\to\infty} \hat{g}_6(r)$ 。在平衡状态下，线性理论预测，$\hat{g}_6^{\infty}$ 随温度呈指数下降 [^51]。在这里，我们确实观察到，对于各种 $D_r, \kappa$ 值，确实有关系 $-\log(\hat{g}_6^{\infty}) \sim s_0^2$ (图 2d)。这表明存在“键序温度” $T_6=t_6 (D_r,\kappa) s_0^2$ 与重新标度的温度 $t_6(D_r,\kappa)$ 与图 2d 中的线的 $s_0^2$ 的预因子成比例。然而，为了成为*有意义的温度*，必须调整 $T_6$ 的绝对值，使其在系统受到白噪声影响时，在极限 $D_r \to \infty$ 下，与平衡时的 $T_S$ 一致。由于 $T_S=(D_r/2 a^2) s_0^2$，我们定义了重新缩放的温度 $t_S(D_r,\kappa)=T_S/s_0^2=D_r/2 a^2$，并全局调整 $t_6$，使其与极限 $D_r \to \infty$ 下的 $T_S$ 一致。然后，我们的数据显示，即使在没有对齐强度 $(\kappa=0)$ 的情况下，随着 $D_r$ 的减少，$t_6$ 是如何偏离 $t_S$ 的。类似地，$t_6<t_S$，并且当 $\kappa$ 增加时，$t_6<t_S$ 越来越大 (图第 2e)。$T_6$ 可以容易地比 $T_S$ 小得多，这表明键序的波动可以保持相当平缓，而位置序的波动很强。由于键无序有助于触发位错对的解离，因此可以认为 $T_6$ 与 $T_D$ 密切相关，这证实了之前介绍的情况。

我们最终证明，我们的结果并不是软相互作用势所特有的，并证实了——这已经在图 2e 中显示了——对于观察到极易变形的活性晶体，对齐 (alignment) 不是必须的。我们重新审视了 Paliwal 和 Dijkstra 最近研究的 ABPs 晶体 [^16]，这些粒子被宣布表现出“无缺陷六角相”，这是从比 $\eta=1/3$ 幂律衰减更快的位置序相关性得出的结论。现在粒子仅通过成对的硬核斥力相互作用。角度遵循等式 (2)，其中 $\kappa=0$，位置遵循

$$
\dot{r}_i = s_0e(\theta_i) + \mu_r \sum_{j \sim i} \partial_r U(r_{ij}) e_{ij} \tag{9}
$$

其中 $U(r)=4\varepsilon[(\sigma/r)^{12} - (\sigma/r)^6]+\varepsilon$ 是在截断距离 $r_c=2^{1/6} \sigma$ 处截断的排斥型 Weeks-Chandler-Andersen 势。使用类似于报道的“无缺陷六角序”的参数值，但考虑到更大的系统，我们发现了一个真正的晶相，具有明显的位置序代数衰变——$\eta$ 值很容易大于 $1/3$——而键取向序是真正的长程的 (图 4) [^58]。改变 $D_r$ 和 $s_0$，我们还是发现 $\eta$ 仅取决于 $T_S=s_0^2/(2 D_r)$，而 $\hat{g}_6^{\infty}$ 不然 (图 4 的插图)，这表明在这种情况下，$T_6<T_S$。

总之，我们已经证明，二维活性晶体中的波动可以在不熔化的情况下引起极大的变形：键序保持在长范围内，位置序代数衰减，但指数 $\eta$ 不受 KTHNY 理论给出的 $1/3$ 上界的限制。对于所研究的简单情况，线性弹性理论使我们能够根据定义明确的有效温度 $T_S$ 和 $T_6$ 来合理化我们的发现，分别量化大规模变形和键序波动。我们特别发现，预期控制熔化的 $T_6$ 可以比 $T_S$ 小得多，从而在保持长程键序的同时允许极端的自发变形。我们的结果的起源于这些极性的唯一时间持久性，这些结果是在活性粒子的固有轴弱排列和不弱排列的情况下获得的 [^59]。因此我们预计，类似的现象也会出现在其他类型的活性晶体中，例如由手性或自旋单元制成的活性晶体。进一步推广，可以看出关键因素是一些有效的时间相关局部噪声的存在。根据这一想法，初步结果表明，即使是被动晶体 (passive crystals)，在受到活性浴 (active bath) 的影响时也可能表现出大幅的自发变形。

## 参考文献

[^1]: J. M. Kosterlitz and D. J. Thouless, J. Phys. C 5, L124 (1972).
[^2]: J. M. Kosterlitz and D. J. Thouless, J. Phys. C 6, 1181 (1973).
[^3]: B. I. Halperin and D. R. Nelson, Phys. Rev. Lett. 41, 121 (1978).
[^4]: D. R. Nelson and B. I. Halperin, Phys. Rev. B 19, 2457 (1979).
[^5]: A. P. Young, Phys. Rev. B 19, 1855 (1979).
[^6]: K. J. Strandburg, Rev. Mod. Phys. 60, 161 (1988).
[^7]: J. Bialké, T. Speck, and H. Löwen, Phys. Rev. Lett. 108, 168301 (2012).
[^8]: G. S. Redner, M. F. Hagan, and A. Baskaran, Phys. Rev. Lett. 110, 055701 (2013).
[^9]: R. Singh and R. Adhikari, Phys. Rev. Lett. 117, 228002 (2016).
[^10]: S. Thutupalli, D. Geyer, R. Singh, R. Adhikari, and H. A. Stone, Proc. Natl. Acad. Sci. U.S.A. 115, 5403 (2018).
[^11]: L. F. Cugliandolo, P. Digregorio, G. Gonnella, and A. Suma, Phys. Rev. Lett. 119, 268002 (2017).
[^12]: P. Digregorio, D. Levis, A. Suma, L. F. Cugliandolo, G. Gonnella, and I. Pagonabarraga, Phys. Rev. Lett. 121, 098003 (2018).
[^13]: P. Digregorio, D. Levis, A. Suma, L. F. Cugliandolo, G. Gonnella, and I. Pagonabarraga, J. Phys. Conf. Ser. 1163, 012073 (2019).
[^14]: J. U. Klamser, S. C. Kapfer, and W. Krauth, Nat. Commun. 9, 5045 (2018).
[^15]: A. Pasupalak, L. Yan-Wei, R. Ni, and M. Pica Ciamarra, Soft Matter 16, 3914 (2020).
[^16]: S. Paliwal and M. Dijkstra, Phys. Rev. Res. 2, 012013(R) (2020).
[^17]: B. Loewe, M. Chiang, D. Marenduzzo, and M. C. Marchetti, Phys. Rev. Lett. 125, 038003 (2020).
[^18]: P. Digregorio, D. Levis, L. F. Cugliandolo, G. Gonnella, and I. Pagonabarraga, Soft Matter 18, 566 (2022).
[^19]: I. H. Riedel, K. Kruse, and J. Howard, Science 309, 300 (2005).
[^20]: Y. Sumino, K. H. Nagai, Y. Shitaka, D. Tanaka, K. Yoshikawa, H. Chaté, and K. Oiwa, Nature (London) 483, 448 (2012).
[^21]: N. H. P. Nguyen, D. Klotsa, M. Engel, and S. C. Glotzer, Phys. Rev. Lett. 112, 075701 (2014).
[^22]: K. Yeo, E. Lushi, and P. M. Vlahovska, Phys. Rev. Lett. 114, 188301 (2015).
[^23]: Y. Goto and H. Tanaka, Nat. Commun. 6, 5994 (2015).
[^24]: A. P. Petroff, X.-L. Wu, and A. Libchaber, Phys. Rev. Lett. 114, 158102 (2015).
[^25]: N. Oppenheimer, D. B. Stein, and M. J. Shelley, Phys. Rev. Lett. 123, 148101 (2019).
[^26]: Z.-F. Huang, A. M. Menzel, and H. Löwen, Phys. Rev. Lett. 125, 218002 (2020).
[^27]: M. James, D. A. Suchla, J. Dunkel, and M. Wilczek, Nat. Commun. 12, 5630 (2021).
[^28]: T. H. Tan, A. Mietke, J. Li, Y. Chen, H. Higinbotham, P. J. Foster, S. Gokhale, J. Dunkel, and N. Fakhri, Nature (London) 607, 287 (2022).
[^29]: N. Oppenheimer, D. B. Stein, M. Y. B. Zion, and M. J. Shelley, Nat. Commun. 13, 804 (2022).
[^30]: B. C. van Zuiden, J. Paulose, W. T. M. Irvine, D. Bartolo, and V. Vitelli, Proc. Natl. Acad. Sci. U.S.A. 113, 12919 (2016).
[^31]: C. Scheibner, A. Souslov, D. Banerjee, P. Surówka, W. T. M. Irvine, and V. Vitelli, Nat. Phys. 16, 475 (2020).
[^32]: E. S. Bililign, F. Balboa Usabiaga, Y. A. Ganan, A. Poncet, V. Soni, S. Magkiriadou, M. J. Shelley, D. Bartolo, and W. T. M. Irvine, Nat. Phys. 18, 212 (2022).
[^33]: L. Braverman, C. Scheibner, B. VanSaders, and V. Vitelli, Phys. Rev. Lett. 127, 268001 (2021).
[^34]: G. Grégoire, H. Chaté, and Y. Tu, Physica (Amsterdam) 181D, 157 (2003).
[^35]: E. Ferrante, A. E. Turgut, M. Dorigo, and C. Huepe, Phys. Rev. Lett. 111, 268302 (2013).
[^36]: E. Ferrante, A. Emre Turgut, M. Dorigo, and C. Huepe, New J. Phys. 15, 095011 (2013).
[^37]: A. M. Menzel, J. Phys. Condens. Matter 25, 505103 (2013).
[^38]: A. M. Menzel and H. Löwen, Phys. Rev. Lett. 110, 055702 (2013).
[^39]: A. M. Menzel, T. Ohta, and H. Löwen, Phys. Rev. E 89, 022301 (2014).
[^40]: L. Ophaus, S. V. Gurevich, and U. Thiele, Phys. Rev. E 98, 022608 (2018).
[^41]: F. Alaimo, S. Praetorius, and A. Voigt, New J. Phys. 18, 083008 (2016).
[^42]: C. A. Weber, C. Bock, and E. Frey, Phys. Rev. Lett. 112, 168301 (2014).
[^43]: S. Rana, M. Samsuzzaman, and A. Saha, Soft Matter 15, 8865 (2019).
[^44]: C. Huang, L. Chen, and X. Xing, Phys. Rev. E 104, 064605 (2021).
[^45]: G. Briand, M. Schindler, and O. Dauchot, Phys. Rev. Lett. 120, 208001 (2018).
[^46]: M. N. van der Linden, L. C. Alexander, D. G. A. L. Aarts, and O. Dauchot, Phys. Rev. Lett. 123, 098001 (2019).
[^47]: A. Maitra and S. Ramaswamy, Phys. Rev. Lett. 123, 238001 (2019).
[^48]: See Supplemental Material at <http://link.aps.org/supplemental/10.1103/PhysRevLett.131.108301> for numerical details of particle simulations, phase diagram, comparison with other correlations functions, and some results of linearised theories.
[^49]: M. Engel, J. A. Anderson, S. C. Glotzer, M. Isobe, E. P. Bernard, and W. Krauth, Phys. Rev. E 87, 042134 (2013).
[^50]: Measurements performed using the more traditional, but oscillatory correlation function $g(r)$, shown in [^48], give essentially the same results, albeit with not as clean an algebraic decay as observed with $\hat{g}(r)$.
[^51]: M. Kardar, Statistical Physics of Fields (Cambridge University Press, Cambridge, England, 2007).
[^52]: Note that μ and λ in principle depend on temperature, something we neglect in this rough argument.
[^53]: For $\kappa = 0$ (no alignment), unsurprisingly, the spatial spectrum is flat. This does not necessarily mean that $T_S = T_D$, since the $\mathbf{s}$ field is still time correlated.
[^54]: P. M. Chaikin and T. C. Lubensky, Principles of Condensed Matter Physics (Cambridge University Press, Cambridge, England, 1995).
[^55]: See, e.g., discussion of the time-dependent Ginzburg-Landau equation in Kardar’s book [^51].
[^56]: In the $\kappa = 0$ nonaligning limit, where the $\mathbf{s}$ spectrum is flat, one has $a = D_r$, and thus $T_S = \frac{1}{2}s_0^2/D_r$, as expected for active Brownian particles; see, e.g., [^57].
[^57]: M. E. Cates and J. Tailleur, Annu. Rev. Condens. Matter Phys. 6, 219 (2015).
[^58]: Note that this is only observed beyond a crossover scale of the order of 100 lattice steps, a sizable numerical difficulty, which comes in addition to having to use small timesteps.
[^59]: The reader might wonder why most of our results are for the rather “exotic” case of weak alignment. The main reason is practical: one can use much larger time steps in this case than with the hardcore WCA potential, saving about 1 order of magnitude of computation time.
