package humanize

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// clickTimeout 是单次点击动作（等待可交互 + 移动 + 移动 + 按下抬起）的硬上限。
// rod 的 WaitInteractable/WaitEnabled/Mouse.* 都不感知调用方 deadline，页面
// 无响应时会一路阻塞到浏览器级超时；这里统一加一层上限，宁可这次点击失败，
// 也不许把整个 read 预算耗尽。
// 采集/评论只读路径把上限压到 10s：正常交互远不需要 30s，异常时快速失败。
const clickTimeout = 10 * time.Second

// boundedContext 给还没有调用方 ctx 的同步调用点（如发布流程）一个带上限的
// 后台 context，保证这些交互也不会无界阻塞。新代码请直接传调用方 ctx。
func boundedContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), clickTimeout)
}

// ClickWithTimeout 是 Click 的同步版本，供发布等尚无调用方 ctx 的流程使用。
func ClickWithTimeout(elem *rod.Element) error {
	ctx, cancel := boundedContext()
	defer cancel()
	return Click(ctx, elem)
}

// ClickAtWithTimeout 是 ClickAt 的同步版本，供发布等尚无调用方 ctx 的流程使用。
func ClickAtWithTimeout(page *rod.Page, pt proto.Point) error {
	ctx, cancel := boundedContext()
	defer cancel()
	return ClickAt(ctx, page, pt)
}

func pressAndRelease(ctx context.Context, mouse *rod.Mouse) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// mouse 来自 page.Context(ctx).Mouse，rod 底层会复用 page ctx 发 CDP；
	// 这里仍优先检查调用方 ctx，避免在取消后继续阻塞。
	if err := mouse.Down(proto.InputMouseButtonLeft, 1); err != nil {
		return err
	}

	select {
	case <-time.After(defaultProvider.Timing()[ClickHold].Sample()):
	case <-ctx.Done():
		_ = mouse.Up(proto.InputMouseButtonLeft, 1)
		return ctx.Err()
	}

	return mouse.Up(proto.InputMouseButtonLeft, 1)
}

func jitterOffset(size float64) float64 {
	limit := math.Min(math.Abs(size)*0.15, 8)
	return (rand.Float64() - 0.5) * 2 * limit
}

func jitterInQuad(pt proto.Point, q proto.DOMQuad) proto.Point {
	return proto.Point{
		X: pt.X + jitterOffset(q[4]-q[0]),
		Y: pt.Y + jitterOffset(q[5]-q[1]),
	}
}

func jitterOn(elem *rod.Element, pt proto.Point) proto.Point {
	shape, err := elem.Shape()
	if err != nil || len(shape.Quads) == 0 {
		return pt
	}
	return jitterInQuad(pt, shape.Quads[0])
}

func ensurePointInViewport(ctx context.Context, page *rod.Page, pt proto.Point) error {
	res, err := page.Context(ctx).Eval(`() => JSON.stringify([window.innerWidth, window.innerHeight])`)
	if err != nil {
		return err
	}

	var size []float64
	if json.Unmarshal([]byte(res.Value.Str()), &size) != nil || len(size) != 2 {
		return nil
	}

	if pt.X < 0 || pt.Y < 0 || pt.X > size[0] || pt.Y > size[1] {
		return fmt.Errorf("落点 (%.0f,%.0f) 在视口 %.0fx%.0f 之外", pt.X, pt.Y, size[0], size[1])
	}
	return nil
}

// 不用 document.elementFromPoint：结果不稳定
func ensureClickable(ctx context.Context, elem *rod.Element, pt proto.Point) error {
	if err := ensurePointInViewport(ctx, elem.Page(), pt); err != nil {
		return err
	}

	res, err := elem.Context(ctx).Eval(`() => getComputedStyle(this).visibility`)
	if err != nil {
		return nil
	}
	if res.Value.Str() == "hidden" {
		return errors.New("元素当前不可命中")
	}
	return nil
}

func Click(ctx context.Context, elem *rod.Element) error {
	ctx, cancel := context.WithTimeout(ctx, clickTimeout)
	defer cancel()
	elem = elem.Context(ctx)

	waitCtx, waitCancel := context.WithTimeout(ctx, 5*time.Second)
	defer waitCancel()
	pt, err := elem.Context(waitCtx).WaitInteractable()
	if err != nil {
		return err
	}

	target := jitterOn(elem, *pt)
	if err := ensureClickable(ctx, elem, target); err != nil {
		return err
	}

	mouse := elem.Page().Context(ctx).Mouse
	if err := moveMouseCurved(ctx, mouse, target); err != nil {
		return err
	}

	Delay(ctx, PointerSettle)

	if err := elem.Context(ctx).WaitEnabled(); err != nil {
		return err
	}

	return pressAndRelease(ctx, mouse)
}

// ClickNoWait 跳过 WaitInteractable 的遮挡重试，用于它会误判而死等的场景。
func ClickNoWait(ctx context.Context, elem *rod.Element) error {
	ctx, cancel := context.WithTimeout(ctx, clickTimeout)
	defer cancel()
	elem = elem.Context(ctx)

	shape, err := elem.Shape()
	if err != nil {
		return err
	}
	if len(shape.Quads) == 0 {
		return errors.New("元素无可点击区域")
	}

	q := shape.Quads[0]
	center := proto.Point{X: (q[0] + q[4]) / 2, Y: (q[1] + q[5]) / 2}

	target := jitterInQuad(center, q)
	if err := ensureClickable(ctx, elem, target); err != nil {
		return err
	}

	mouse := elem.Page().Context(ctx).Mouse
	if err := moveMouseCurved(ctx, mouse, target); err != nil {
		return err
	}
	return pressAndRelease(ctx, mouse)
}

func MoveTo(ctx context.Context, page *rod.Page, pt proto.Point) error {
	return moveMouseCurved(ctx, page.Context(ctx).Mouse, pt)
}

func Hover(ctx context.Context, elem *rod.Element) error {
	ctx, cancel := context.WithTimeout(ctx, clickTimeout)
	defer cancel()
	elem = elem.Context(ctx)

	shape, err := elem.Shape()
	if err != nil {
		return err
	}
	if len(shape.Quads) == 0 {
		return errors.New("元素无可悬停区域")
	}

	q := shape.Quads[0]
	center := proto.Point{X: (q[0] + q[4]) / 2, Y: (q[1] + q[5]) / 2}

	target := jitterInQuad(center, q)
	if err := ensureClickable(ctx, elem, target); err != nil {
		return err
	}

	return moveMouseCurved(ctx, elem.Page().Context(ctx).Mouse, target)
}

func ClickAt(ctx context.Context, page *rod.Page, pt proto.Point) error {
	ctx, cancel := context.WithTimeout(ctx, clickTimeout)
	defer cancel()
	page = page.Context(ctx)

	if err := ensurePointInViewport(ctx, page, pt); err != nil {
		return err
	}
	if err := moveMouseCurved(ctx, page.Mouse, pt); err != nil {
		return err
	}
	return pressAndRelease(ctx, page.Mouse)
}

func Type(ctx context.Context, elem *rod.Element, text string) error {
	dist := defaultProvider.Timing()[Keystroke]
	elem = elem.Context(ctx)

	if err := elem.Focus(); err != nil {
		return err
	}
	if err := elem.WaitEnabled(); err != nil {
		return err
	}
	if err := elem.WaitWritable(); err != nil {
		return err
	}

	page := elem.Page().Context(ctx)

	for _, r := range text {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := page.InsertText(string(r)); err != nil {
			return err
		}

		t := time.NewTimer(dist.Sample())
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		}
	}
	return nil
}
